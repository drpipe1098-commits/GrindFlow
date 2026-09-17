import 'server-only';

import type { CloudClient, ListContext, RemoteFile, RemoteListing } from './provider';

/**
 * Cliente de la API de Dropbox.
 *
 * Sin SDK: la API es HTTP plano y el SDK oficial arrastra dependencias y un
 * modelo de errores propio para lo que aqui son cinco llamadas. Menos superficie
 * que mantener y nada que actualizar cuando el SDK cambie de mayor.
 */

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';

export class DropboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True cuando el token dejo de valer y hay que reconectar, no reintentar. */
    readonly needsReconnect = false,
  ) {
    super(message);
    this.name = 'DropboxError';
  }
}

export interface DropboxTokens {
  accessToken: string;
  /** Solo viene en el primer intercambio, no al refrescar. */
  refreshToken: string | null;
  expiresInSeconds: number;
  accountId: string | null;
  scopes: string[];
}

/**
 * URL a la que se manda a la persona para que autorice.
 *
 * `token_access_type=offline` es lo que hace que Dropbox entregue un refresh
 * token. Sin ese parametro solo se obtiene un acceso de cuatro horas y el
 * escaneo programado deja de funcionar esa misma tarde.
 */
export function buildAuthorizeUrl(input: {
  appKey: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', input.appKey);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('state', input.state);
  return url.toString();
}

async function postForm(
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    cache: 'no-store',
  });

  const text = await response.text();

  if (!response.ok) {
    // `invalid_grant` significa que la persona revoco el acceso o cambio la
    // contrasena. Reintentarlo no lo arregla nunca y, repetido, acaba con la
    // aplicacion limitada por Dropbox.
    const needsReconnect = response.status === 400 && text.includes('invalid_grant');
    throw new DropboxError(
      `Dropbox respondio ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      needsReconnect,
    );
  }

  return JSON.parse(text) as Record<string, unknown>;
}

export async function exchangeCodeForTokens(input: {
  code: string;
  appKey: string;
  appSecret: string;
  redirectUri: string;
}): Promise<DropboxTokens> {
  const data = await postForm(TOKEN_URL, {
    code: input.code,
    grant_type: 'authorization_code',
    client_id: input.appKey,
    client_secret: input.appSecret,
    redirect_uri: input.redirectUri,
  });

  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : null;

  // Es el unico momento en que Dropbox entrega el refresh token. Si la respuesta
  // no lo trae, la conexion nacera muerta: mejor fallar aqui, donde la persona
  // esta delante y puede reintentar, que dentro de cuatro horas en un worker.
  if (refreshToken === null) {
    throw new DropboxError(
      'Dropbox no devolvio refresh token. Revisa que la autorizacion use ' +
        'token_access_type=offline y vuelve a conectar.',
      400,
      true,
    );
  }

  return {
    accessToken: String(data.access_token),
    refreshToken,
    expiresInSeconds: Number(data.expires_in ?? 14_400),
    accountId: typeof data.account_id === 'string' ? data.account_id : null,
    scopes: typeof data.scope === 'string' ? data.scope.split(' ') : [],
  };
}

export async function refreshAccessToken(input: {
  refreshToken: string;
  appKey: string;
  appSecret: string;
}): Promise<DropboxTokens> {
  const data = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.appKey,
    client_secret: input.appSecret,
  });

  return {
    accessToken: String(data.access_token),
    // Al refrescar no viene uno nuevo: se conserva el que ya se tenia.
    refreshToken: null,
    expiresInSeconds: Number(data.expires_in ?? 14_400),
    accountId: null,
    scopes: typeof data.scope === 'string' ? data.scope.split(' ') : [],
  };
}

async function callApi(
  accessToken: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body === null ? 'null' : JSON.stringify(body),
    cache: 'no-store',
  });

  const text = await response.text();

  if (!response.ok) {
    throw new DropboxError(
      `Dropbox ${path} respondio ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      response.status === 401,
    );
  }

  return JSON.parse(text) as Record<string, unknown>;
}

export interface DropboxAccount {
  accountId: string;
  email: string | null;
  displayName: string | null;
}

export async function getCurrentAccount(accessToken: string): Promise<DropboxAccount> {
  const data = await callApi(accessToken, '/users/get_current_account', null);
  const name = data.name as Record<string, unknown> | undefined;

  return {
    accountId: String(data.account_id),
    email: typeof data.email === 'string' ? data.email : null,
    displayName: typeof name?.display_name === 'string' ? name.display_name : null,
  };
}

export interface DropboxFile {
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
  sizeBytes: number;
  serverModified: string;
  /** Hash propietario de Dropbox. NO es SHA-256. */
  contentHash: string | null;
}

export interface DropboxListing {
  files: DropboxFile[];
  cursor: string;
  hasMore: boolean;
}

function mapEntries(entries: unknown): DropboxFile[] {
  if (!Array.isArray(entries)) return [];

  return entries
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['.tag'] === 'file',
    )
    .map((entry) => ({
      id: String(entry.id),
      name: String(entry.name),
      pathLower: String(entry.path_lower ?? ''),
      pathDisplay: String(entry.path_display ?? entry.path_lower ?? ''),
      sizeBytes: Number(entry.size ?? 0),
      serverModified: String(entry.server_modified ?? new Date().toISOString()),
      contentHash: typeof entry.content_hash === 'string' ? entry.content_hash : null,
    }));
}

/**
 * Primera pagina de un listado recursivo.
 *
 * La raiz de una cuenta se pide con cadena vacia, no con "/": Dropbox rechaza la
 * barra sola.
 */
export async function listFolder(input: {
  accessToken: string;
  path: string | null;
}): Promise<DropboxListing> {
  const path = input.path === null || input.path === '/' ? '' : input.path.replace(/\/+$/, '');

  const data = await callApi(input.accessToken, '/files/list_folder', {
    path,
    recursive: true,
    include_deleted: false,
    include_media_info: false,
    limit: 500,
  });

  return {
    files: mapEntries(data.entries),
    cursor: String(data.cursor),
    hasMore: Boolean(data.has_more),
  };
}

/**
 * Continua un listado, o trae solo lo que cambio desde la ultima pasada.
 *
 * Es la misma llamada para las dos cosas, y ahi esta el ahorro: guardado el
 * cursor de la pasada anterior, Dropbox devuelve unicamente las novedades. En
 * una cuenta con anos de material, la diferencia es entre minutos y horas.
 */
export async function listFolderContinue(input: {
  accessToken: string;
  cursor: string;
}): Promise<DropboxListing> {
  const data = await callApi(input.accessToken, '/files/list_folder/continue', {
    cursor: input.cursor,
  });

  return {
    files: mapEntries(data.entries),
    cursor: String(data.cursor),
    hasMore: Boolean(data.has_more),
  };
}

/**
 * Descarga un archivo y devuelve el cuerpo como flujo.
 *
 * Flujo y no buffer: hay videos de varios gigabytes y cargarlos enteros en
 * memoria tumbaria el contenedor con el primero.
 */
export async function downloadFile(input: {
  accessToken: string;
  pathOrId: string;
}): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${CONTENT_BASE}/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      // El argumento va en cabecera, no en el cuerpo: el cuerpo es la respuesta.
      'Dropbox-API-Arg': JSON.stringify({ path: input.pathOrId }),
    },
    cache: 'no-store',
  });

  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '');
    throw new DropboxError(
      `Dropbox no entrego ${input.pathOrId}: ${response.status} ${detail.slice(0, 200)}`,
      response.status,
      response.status === 401,
    );
  }

  return response.body;
}

/**
 * Adaptador a la interfaz comun de proveedores.
 *
 * Dropbox encaja casi sin traduccion: tiene rutas de verdad y listado recursivo
 * nativo, y el mismo cursor sirve para paginar y para incrementar.
 */
export const dropboxClient: CloudClient = {
  provider: 'dropbox',

  async listInitial(context: ListContext): Promise<RemoteListing> {
    const listing = await listFolder({
      accessToken: context.accessToken,
      path: context.rootPath,
    });
    return { files: listing.files.map(toRemoteFile), cursor: listing.cursor, hasMore: listing.hasMore };
  },

  async listIncremental(context): Promise<RemoteListing> {
    const listing = await listFolderContinue({
      accessToken: context.accessToken,
      cursor: context.cursor,
    });
    return { files: listing.files.map(toRemoteFile), cursor: listing.cursor, hasMore: listing.hasMore };
  },

  async download(input): Promise<ReadableStream<Uint8Array>> {
    return downloadFile({ accessToken: input.accessToken, pathOrId: input.fileId });
  },
};

function toRemoteFile(file: DropboxFile): RemoteFile {
  return {
    id: file.id,
    name: file.name,
    path: file.pathDisplay,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.serverModified,
    checksum: file.contentHash,
  };
}
