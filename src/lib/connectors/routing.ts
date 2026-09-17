/**
 * Enrutado de archivos descubiertos hacia un perfil.
 *
 * Tres modos, en este orden:
 *
 *   1. `default_profile_id` en la conexion — el caso de la modelo independiente:
 *      todo lo que caiga en su Dropbox es suyo. Manda sobre cualquier otra
 *      regla, porque es una decision explicita de quien conecto la cuenta.
 *   2. Nombre de la subcarpeta de primer nivel — el caso del estudio con carpeta
 *      compartida: `/Modelos/alfa_uno/set01/foto.jpg` va al perfil `alfa_uno`.
 *   3. Sin asignar — queda para triaje manual.
 *
 * Codigo puro: no toca la base ni la red. Recibe los perfiles ya cargados y
 * devuelve una decision, de modo que cada regla y cada empate se pueden probar
 * con datos fijos.
 */

export interface RoutableProfile {
  id: string;
  handle: string;
  displayName: string;
}

export interface RoutingInput {
  /** Ruta completa del archivo remoto, con barras: `/Modelos/alfa_uno/set01/a.jpg`. */
  remotePath: string;
  /** Carpeta raiz autorizada de la conexion. `null` si es la raiz de la cuenta. */
  rootPath: string | null;
  /** Perfil por defecto de la conexion, si lo hay. */
  defaultProfileId: string | null;
  /** Perfiles de la organizacion, para intentar el match por nombre. */
  profiles: readonly RoutableProfile[];
}

export type AssignmentSource = 'default' | 'folder_match' | 'manual';

export interface RoutingDecision {
  profileId: string | null;
  source: AssignmentSource | null;
  /** Subcarpeta con la que se intento el match. Se guarda aunque falle. */
  matchedFolder: string | null;
  /** Por que no se pudo asignar. Es lo que el panel muestra en el triaje. */
  reason?: 'sin_subcarpeta' | 'sin_coincidencia' | 'coincidencia_ambigua';
}

/**
 * Deja un nombre en su forma comparable.
 *
 * Una carpeta se llama "Alfa Uno", "alfa-uno" o "alfa_uno" segun quien la creo,
 * y el handle es `alfa_uno`. Quitar acentos, mayusculas y todo lo que no sea
 * alfanumerico hace que las tres formas coincidan.
 */
export function normalizeFolderName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Subcarpeta de primer nivel por debajo de la raiz autorizada.
 *
 * Devuelve `null` cuando el archivo cuelga directamente de la raiz: ahi no hay
 * carpeta con la que hacer match.
 */
export function firstLevelFolder(remotePath: string, rootPath: string | null): string | null {
  const normalizedRoot = (rootPath ?? '').replace(/\/+$/, '');
  let relative = remotePath;

  if (normalizedRoot !== '' && remotePath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    relative = remotePath.slice(normalizedRoot.length);
  }

  const segments = relative.split('/').filter((segment) => segment !== '');

  // Con un solo segmento, ese segmento es el archivo: no hay carpeta.
  return segments.length >= 2 ? (segments[0] ?? null) : null;
}

export function routeToProfile(input: RoutingInput): RoutingDecision {
  // --- 1. Perfil por defecto -------------------------------------------------
  if (input.defaultProfileId !== null) {
    return { profileId: input.defaultProfileId, source: 'default', matchedFolder: null };
  }

  // --- 2. Match por nombre de subcarpeta -------------------------------------
  const folder = firstLevelFolder(input.remotePath, input.rootPath);

  if (folder === null) {
    return { profileId: null, source: null, matchedFolder: null, reason: 'sin_subcarpeta' };
  }

  const target = normalizeFolderName(folder);
  if (target === '') {
    return { profileId: null, source: null, matchedFolder: folder, reason: 'sin_coincidencia' };
  }

  const matches = input.profiles.filter(
    (profile) =>
      normalizeFolderName(profile.handle) === target ||
      normalizeFolderName(profile.displayName) === target,
  );

  // Dos perfiles que normalizan igual ("Alfa Uno" y "alfa-uno"): no se adivina.
  // Mandar el material de una modelo al perfil de otra es peor que dejarlo sin
  // asignar, porque nadie lo revisa y acaba publicado en la cuenta equivocada.
  if (matches.length > 1) {
    return {
      profileId: null,
      source: null,
      matchedFolder: folder,
      reason: 'coincidencia_ambigua',
    };
  }

  const match = matches[0];
  if (match === undefined) {
    return { profileId: null, source: null, matchedFolder: folder, reason: 'sin_coincidencia' };
  }

  return { profileId: match.id, source: 'folder_match', matchedFolder: folder };
}
