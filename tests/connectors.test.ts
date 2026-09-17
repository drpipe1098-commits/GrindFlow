/**
 * Pruebas de los conectores de nube.
 *
 * Se centran en el enrutado, que es donde un error tiene consecuencias visibles:
 * asignar el material de una modelo al perfil de otra acaba con contenido
 * publicado en la cuenta equivocada, y nadie lo revisa porque el sistema cree
 * que acerto.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  firstLevelFolder,
  normalizeFolderName,
  routeToProfile,
  type RoutableProfile,
} from '@/lib/connectors/routing';
import {
  isJunkFile,
  isSupportedMedia,
  mediaTypeOf,
  mimeTypeOf,
} from '@/workers/ingest/media-types';
import { createOAuthState, verifyOAuthState } from '@/lib/connectors/oauth-state';

const PERFILES: RoutableProfile[] = [
  { id: 'p-alfa', handle: 'alfa_uno', displayName: 'Alfa Uno' },
  { id: 'p-beta', handle: 'beta_dos', displayName: 'Beta Dos' },
];

describe('modo 1: perfil por defecto', () => {
  it('asigna todo al perfil de la conexion', () => {
    // El caso de la modelo independiente: su Dropbox entero es suyo.
    const decision = routeToProfile({
      remotePath: '/lo-que-sea/foto.jpg',
      rootPath: null,
      defaultProfileId: 'p-alfa',
      profiles: PERFILES,
    });

    expect(decision.profileId).toBe('p-alfa');
    expect(decision.source).toBe('default');
  });

  it('manda sobre el match por carpeta', () => {
    // Es una decision explicita de quien conecto la cuenta: pesa mas que una
    // deduccion a partir del nombre de una carpeta.
    const decision = routeToProfile({
      remotePath: '/Modelos/beta_dos/foto.jpg',
      rootPath: '/Modelos',
      defaultProfileId: 'p-alfa',
      profiles: PERFILES,
    });

    expect(decision.profileId).toBe('p-alfa');
    expect(decision.source).toBe('default');
  });
});

describe('modo 2: match por subcarpeta', () => {
  const sinDefecto = (remotePath: string, rootPath: string | null = '/Modelos') =>
    routeToProfile({ remotePath, rootPath, defaultProfileId: null, profiles: PERFILES });

  it('empareja por handle', () => {
    const decision = sinDefecto('/Modelos/alfa_uno/set01/foto.jpg');
    expect(decision.profileId).toBe('p-alfa');
    expect(decision.source).toBe('folder_match');
    expect(decision.matchedFolder).toBe('alfa_uno');
  });

  it('empareja por nombre publico', () => {
    const decision = sinDefecto('/Modelos/Alfa Uno/set01/foto.jpg');
    expect(decision.profileId).toBe('p-alfa');
  });

  it('tolera guiones, espacios, mayusculas y acentos', () => {
    // Quien creo la carpeta no sabia el handle exacto.
    expect(sinDefecto('/Modelos/ALFA-UNO/a.jpg').profileId).toBe('p-alfa');
    expect(sinDefecto('/Modelos/Álfa Úno/a.jpg').profileId).toBe('p-alfa');
  });

  it('solo mira el primer nivel, no las subcarpetas profundas', () => {
    const decision = sinDefecto('/Modelos/alfa_uno/2024/marzo/sesion/a.jpg');
    expect(decision.matchedFolder).toBe('alfa_uno');
    expect(decision.profileId).toBe('p-alfa');
  });

  it('no asigna cuando ningun perfil coincide', () => {
    const decision = sinDefecto('/Modelos/carpeta-vieja/a.jpg');
    expect(decision.profileId).toBeNull();
    expect(decision.reason).toBe('sin_coincidencia');
    // La carpeta se conserva: es lo que el estudio necesita ver en el triaje.
    expect(decision.matchedFolder).toBe('carpeta-vieja');
  });

  it('no asigna cuando el archivo cuelga de la raiz', () => {
    const decision = sinDefecto('/Modelos/suelta.jpg');
    expect(decision.profileId).toBeNull();
    expect(decision.reason).toBe('sin_subcarpeta');
  });

  it('se niega a adivinar ante dos perfiles equivalentes', () => {
    // Mandar el material a la modelo equivocada es peor que dejarlo sin asignar:
    // sin asignar alguien lo revisa; mal asignado, nadie.
    const ambiguos: RoutableProfile[] = [
      { id: 'p-1', handle: 'alfa_uno', displayName: 'Otra' },
      { id: 'p-2', handle: 'otra', displayName: 'Alfa Uno' },
    ];

    const decision = routeToProfile({
      remotePath: '/Modelos/alfa uno/a.jpg',
      rootPath: '/Modelos',
      defaultProfileId: null,
      profiles: ambiguos,
    });

    expect(decision.profileId).toBeNull();
    expect(decision.reason).toBe('coincidencia_ambigua');
  });

  it('funciona con la raiz de la cuenta', () => {
    const decision = routeToProfile({
      remotePath: '/alfa_uno/set01/a.jpg',
      rootPath: null,
      defaultProfileId: null,
      profiles: PERFILES,
    });

    expect(decision.profileId).toBe('p-alfa');
  });

  it('no asigna cuando no hay ningun perfil en la organizacion', () => {
    const decision = routeToProfile({
      remotePath: '/Modelos/alfa_uno/a.jpg',
      rootPath: '/Modelos',
      defaultProfileId: null,
      profiles: [],
    });

    expect(decision.profileId).toBeNull();
  });
});

describe('extraccion de la subcarpeta', () => {
  it('quita la raiz sin distinguir mayusculas', () => {
    expect(firstLevelFolder('/Modelos/alfa/a.jpg', '/modelos')).toBe('alfa');
  });

  it('tolera barra final en la raiz', () => {
    expect(firstLevelFolder('/Modelos/alfa/a.jpg', '/Modelos/')).toBe('alfa');
  });

  it('devuelve null si el archivo esta suelto en la raiz', () => {
    expect(firstLevelFolder('/Modelos/a.jpg', '/Modelos')).toBeNull();
  });

  it('normaliza nombres a su forma comparable', () => {
    expect(normalizeFolderName('Álfa-Úno_01')).toBe('alfauno01');
    expect(normalizeFolderName('   ')).toBe('');
  });
});

describe('que archivos se traen', () => {
  it('acepta fotos y videos', () => {
    expect(isSupportedMedia('foto.JPG')).toBe(true);
    expect(isSupportedMedia('video.mov')).toBe(true);
    expect(mediaTypeOf('a.heic')).toBe('image');
    expect(mediaTypeOf('a.mkv')).toBe('video');
  });

  it('descarta lo que no es material publicable', () => {
    // Una carpeta compartida de anos tiene contratos, hojas de calculo y ruido.
    expect(isSupportedMedia('contrato.pdf')).toBe(false);
    expect(isSupportedMedia('cuentas.xlsx')).toBe(false);
    expect(mediaTypeOf('notas.txt')).toBeNull();
  });

  it('descarta la basura que dejan los sistemas operativos', () => {
    expect(isJunkFile('.DS_Store')).toBe(true);
    expect(isJunkFile('Thumbs.db')).toBe(true);
    expect(isJunkFile('foto.jpg')).toBe(false);
  });

  it('deduce el tipo MIME por la extension', () => {
    expect(mimeTypeOf('a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeOf('a.mov')).toBe('video/quicktime');
    expect(mimeTypeOf('a.desconocido')).toBe('application/octet-stream');
  });
});

describe('estado de OAuth2', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('conserva el contenido en el ida y vuelta', () => {
    const { state, nonce } = createOAuthState({
      organizationId: 'org-1',
      userId: 'user-1',
      provider: 'dropbox',
    });

    const payload = verifyOAuthState(state);
    expect(payload?.organizationId).toBe('org-1');
    expect(payload?.userId).toBe('user-1');
    expect(payload?.nonce).toBe(nonce);
  });

  it('rechaza una firma alterada', () => {
    // Es lo que impide que un tercero fabrique un state y consiga que una
    // agencia conecte la nube del atacante dentro de su organizacion.
    const { state } = createOAuthState({
      organizationId: 'org-1',
      userId: 'user-1',
      provider: 'dropbox',
    });

    const [payload, firma] = state.split('.') as [string, string];
    const alterada = firma.slice(0, -2) + (firma.endsWith('A') ? 'BB' : 'AA');
    expect(verifyOAuthState(`${payload}.${alterada}`)).toBeNull();
  });

  it('rechaza un contenido alterado', () => {
    const { state } = createOAuthState({
      organizationId: 'org-1',
      userId: 'user-1',
      provider: 'dropbox',
    });

    const otro = Buffer.from(
      JSON.stringify({
        organizationId: 'org-del-atacante',
        userId: 'user-1',
        provider: 'dropbox',
        nonce: 'x',
        issuedAt: Math.floor(Date.now() / 1000),
      }),
      'utf8',
    ).toString('base64url');

    expect(verifyOAuthState(`${otro}.${state.split('.')[1]}`)).toBeNull();
  });

  it('rechaza un formato que no sea de dos partes', () => {
    expect(verifyOAuthState('sin-punto')).toBeNull();
    expect(verifyOAuthState('a.b.c')).toBeNull();
  });

  it('caduca a los diez minutos', () => {
    // Un flujo de OAuth que tarda mas es un flujo abandonado, y un state eterno
    // es un state reutilizable.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T10:00:00Z'));

    const { state } = createOAuthState({
      organizationId: 'org-1',
      userId: 'user-1',
      provider: 'dropbox',
    });

    vi.setSystemTime(new Date('2026-04-01T10:09:00Z'));
    expect(verifyOAuthState(state)).not.toBeNull();

    vi.setSystemTime(new Date('2026-04-01T10:11:00Z'));
    expect(verifyOAuthState(state)).toBeNull();
  });
});
