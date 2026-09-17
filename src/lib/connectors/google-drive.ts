import 'server-only';

import type { CloudClient, ListContext, RemoteFile, RemoteListing } from './provider';

/**
 * Cliente de Google Drive.
 *
 * Drive se parece poco a Dropbox y conviene tenerlo presente al leer esto:
 *
 *   - No hay listado recursivo. `files.list` solo devuelve los hijos directos de
 *     una carpeta, asi que el recorrido inicial es un recorrido en anchura que
 *     va construyendo las rutas por el camino. Esas rutas hacen falta: el motor
 *     de enrutado empareja por el nombre de la subcarpeta de primer nivel.
 *   - Lo incremental va por otra via (`changes.list`) y devuelve cambios de TODO
 *     el Drive, no solo de la carpeta autorizada, asi que hay que filtrar
 *     subiendo por los `parents` de cada archivo hasta la raiz.
 *
 * Alcance: solo `drive.readonly`. Es el minimo que permite listar una carpeta ya
 * existente — `drive.file` unicamente ve lo que la propia aplicacion creo, que
 * para un reciclador de material antiguo no sirve de nada.
 */

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/** Presupuesto de paginas por ejecucion, para que un Drive enorme no bloquee el worker. */
const MAX_PAGES_PER_RUN = 200;
const PAGE_SIZE = 200;

export class GoogleDriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly needsReconnect = false,
  ) {
    super(message);
    this.name = 'GoogleDriveError';
  }
}

/**
 * URL de autorizacion.
 *
 * Dos parametros que no son opcionales en la practica:
 *
 *   `access_type=offline` — sin el no hay refresh token y la conexion muere en
 *   una hora.
 *
 *   `prompt=consent` — Google entrega el refresh token SOLO la primera vez que
 *   una cuenta autoriza una aplicacion. Si la persona ya autorizo antes (una
 *   prueba, una reconexion tras revocar), la segunda vez no llega ninguno y la
 *   conexion nace muerta sin ningun error visible. Forzar el consentimiento lo
 *   hace fiable, a cambio de una pantalla extra. Es el fallo mas comun de estas
 *   integraciones y la razon de que se fuerce siempre.
 */
export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', input.state);
  return url.toString();
}

export interface DriveTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scopes: string[];
}

async function postForm(body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    cache: 'no-store',
  });

  const text = await response.text();

  if (!response.ok) {
    // `invalid_grant` es revocacion o cambio de contrasena: reintentar no lo
    // arregla nunca.
    const needsReconnect = text.includes('invalid_grant');
    throw new GoogleDriveError(
      `Google respondio ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      needsReconnect,
    );
  }

  return JSON.parse(text) as Record<string, unknown>;
}

export async function exchangeCodeForTokens(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<DriveTokens> {
  const data = await postForm({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });

  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : null;

  if (refreshToken === null) {
    throw new GoogleDriveError(
      'Google no devolvio refresh token. Ocurre cuando la cuenta ya habia ' +
        'autorizado antes: hace falta prompt=consent, o revocar el acceso en ' +
        'la cuenta de Google y volver a conectar.',
      400,
      true,
    );
  }

  return {
    accessToken: String(data.access_token),
    refreshToken,
    expiresInSeconds: Number(data.expires_in ?? 3600),
    scopes: typeof data.scope === 'string' ? data.scope.split(' ') : [DRIVE_SCOPE],
  };
}

export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<DriveTokens> {
  const data = await postForm({
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: 'refresh_token',
  });

  return {
    accessToken: String(data.access_token),
    // Al refrescar no llega uno nuevo: se conserva el que ya se tenia.
    refreshToken: null,
    expiresInSeconds: Number(data.expires_in ?? 3600),
    scopes: typeof data.scope === 'string' ? data.scope.split(' ') : [DRIVE_SCOPE],
  };
}

async function driveGet(
  accessToken: string,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${DRIVE_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });

  const text = await response.text();

  if (!response.ok) {
    throw new GoogleDriveError(
      `Google Drive ${path} respondio ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      response.status === 401,
    );
  }

  return JSON.parse(text) as Record<string, unknown>;
}

export interface DriveAccount {
  email: string | null;
  displayName: string | null;
}

/**
 * Datos de la cuenta conectada.
 *
 * Se pide a `drive/about` y no al endpoint `userinfo` porque ese exige los
 * alcances `openid`/`email`, y el principio es pedir solo `drive.readonly`.
 * `about` da el correo dentro del mismo alcance de Drive.
 */
export async function getCurrentAccount(accessToken: string): Promise<DriveAccount> {
  const data = await driveGet(accessToken, '/about', { fields: 'user' });
  const user = data.user as Record<string, unknown> | undefined;

  return {
    email: typeof user?.emailAddress === 'string' ? user.emailAddress : null,
    displayName: typeof user?.displayName === 'string' ? user.displayName : null,
  };
}

/** Punto de partida para lo incremental. Se pide ANTES del recorrido inicial. */
export async function getStartPageToken(accessToken: string): Promise<string> {
  const data = await driveGet(accessToken, '/changes/startPageToken', {
    supportsAllDrives: 'true',
  });
  return String(data.startPageToken);
}

interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedTime: string;
  md5Checksum: string | null;
  parents: string[];
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function mapEntry(raw: unknown): DriveEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return null;

  return {
    id: entry.id,
    name: entry.name,
    mimeType: String(entry.mimeType ?? ''),
    size: Number(entry.size ?? 0),
    modifiedTime: String(entry.modifiedTime ?? new Date().toISOString()),
    md5Checksum: typeof entry.md5Checksum === 'string' ? entry.md5Checksum : null,
    parents: Array.isArray(entry.parents) ? entry.parents.map(String) : [],
  };
}

const FILE_FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)';

async function listChildren(
  accessToken: string,
  folderId: string,
  pageToken: string | null,
): Promise<{ entries: DriveEntry[]; nextPageToken: string | null }> {
  const params: Record<string, string> = {
    q: `'${folderId}' in parents and trashed = false`,
    fields: FILE_FIELDS,
    pageSize: String(PAGE_SIZE),
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  };
  if (pageToken !== null) params.pageToken = pageToken;

  const data = await driveGet(accessToken, '/files', params);
  const entries = Array.isArray(data.files)
    ? data.files.map(mapEntry).filter((entry): entry is DriveEntry => entry !== null)
    : [];

  return {
    entries,
    nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null,
  };
}

/**
 * Recorrido en anchura del arbol, construyendo las rutas por el camino.
 *
 * Idempotente a proposito: si se agota el presupuesto de paginas, la ejecucion
 * termina sin guardar cursor y la siguiente vuelve a empezar. Rehacer el
 * recorrido es barato —los `upsert` por (conexion, archivo remoto) absorben lo ya
 * registrado y no se descarga nada— asi que es preferible a guardar un estado
 * intermedio que habria que reanudar con exactitud.
 */
async function walkTree(accessToken: string, rootId: string): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  const queue: { id: string; path: string }[] = [{ id: rootId, path: '' }];
  const seenFolders = new Set<string>([rootId]);
  let pages = 0;

  while (queue.length > 0 && pages < MAX_PAGES_PER_RUN) {
    const folder = queue.shift();
    if (folder === undefined) break;

    let pageToken: string | null = null;

    do {
      const page: { entries: DriveEntry[]; nextPageToken: string | null } = await listChildren(
        accessToken,
        folder.id,
        pageToken,
      );
      pages += 1;
      pageToken = page.nextPageToken;

      for (const entry of page.entries) {
        const path = `${folder.path}/${entry.name}`;

        if (entry.mimeType === FOLDER_MIME) {
          // Un atajo en Drive puede apuntar a una carpeta ya visitada y el
          // recorrido entraria en bucle.
          if (!seenFolders.has(entry.id)) {
            seenFolders.add(entry.id);
            queue.push({ id: entry.id, path });
          }
          continue;
        }

        files.push({
          id: entry.id,
          name: entry.name,
          path,
          sizeBytes: entry.size,
          modifiedAt: entry.modifiedTime,
          checksum: entry.md5Checksum,
        });
      }
    } while (pageToken !== null && pages < MAX_PAGES_PER_RUN);
  }

  return files;
}

/**
 * Ruta de un archivo subiendo por sus `parents` hasta la raiz autorizada.
 *
 * Lo necesita el camino incremental: `changes.list` devuelve cambios de todo el
 * Drive, no solo de la carpeta que la agencia autorizo. Sin este filtro se
 * ingeriria material de carpetas que nadie ofrecio.
 *
 * Devuelve `null` si el archivo no cuelga de la raiz.
 */
async function resolvePathUnderRoot(
  accessToken: string,
  entry: DriveEntry,
  rootId: string,
  folderCache: Map<string, DriveEntry | null>,
): Promise<string | null> {
  const segments: string[] = [entry.name];
  let current = entry.parents[0] ?? null;
  let depth = 0;

  while (current !== null && depth < 20) {
    if (current === rootId) {
      return `/${segments.reverse().join('/')}`;
    }

    let parent = folderCache.get(current);
    if (parent === undefined) {
      try {
        const data = await driveGet(accessToken, `/files/${current}`, {
          fields: 'id,name,mimeType,parents',
          supportsAllDrives: 'true',
        });
        parent = mapEntry(data);
      } catch {
        parent = null;
      }
      folderCache.set(current, parent);
    }

    if (parent === null) return null;

    segments.push(parent.name);
    current = parent.parents[0] ?? null;
    depth += 1;
  }

  return null;
}

export const googleDriveClient: CloudClient = {
  provider: 'google_drive',

  async listInitial(context: ListContext): Promise<RemoteListing> {
    const rootId = context.rootId ?? 'root';

    // El punto de partida de lo incremental se pide ANTES de recorrer. Al reves,
    // los cambios ocurridos durante el recorrido —que puede durar minutos— se
    // perderian: ni los veria el recorrido ni los traeria el primer incremento.
    const startPageToken = await getStartPageToken(context.accessToken);
    const files = await walkTree(context.accessToken, rootId);

    return { files, cursor: startPageToken, hasMore: false };
  },

  async listIncremental(context): Promise<RemoteListing> {
    const rootId = context.rootId ?? 'root';

    const data = await driveGet(context.accessToken, '/changes', {
      pageToken: context.cursor,
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${'id,name,mimeType,size,modifiedTime,md5Checksum,parents'}))`,
      pageSize: String(PAGE_SIZE),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });

    const changes = Array.isArray(data.changes) ? data.changes : [];
    const folderCache = new Map<string, DriveEntry | null>();
    const files: RemoteFile[] = [];

    for (const raw of changes) {
      const change = raw as Record<string, unknown>;
      if (change.removed === true) continue;

      const entry = mapEntry(change.file);
      if (entry === null || entry.mimeType === FOLDER_MIME) continue;

      const path = await resolvePathUnderRoot(context.accessToken, entry, rootId, folderCache);
      if (path === null) continue;

      files.push({
        id: entry.id,
        name: entry.name,
        path,
        sizeBytes: entry.size,
        modifiedAt: entry.modifiedTime,
        checksum: entry.md5Checksum,
      });
    }

    const next =
      typeof data.nextPageToken === 'string'
        ? data.nextPageToken
        : typeof data.newStartPageToken === 'string'
          ? data.newStartPageToken
          : context.cursor;

    return { files, cursor: next, hasMore: typeof data.nextPageToken === 'string' };
  },

  async download(input): Promise<ReadableStream<Uint8Array>> {
    const url = new URL(`${DRIVE_BASE}/files/${input.fileId}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      cache: 'no-store',
    });

    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '');
      throw new GoogleDriveError(
        `Drive no entrego ${input.fileId}: ${response.status} ${detail.slice(0, 200)}`,
        response.status,
        response.status === 401,
      );
    }

    return response.body;
  },
};
