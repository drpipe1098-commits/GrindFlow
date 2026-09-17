/**
 * Clasificacion de fallos de publicacion y calculo de la espera.
 *
 * Codigo puro: recibe el estado HTTP, las cabeceras y el cuerpo, y decide que
 * hacer. Ni red, ni base, ni reloj propio.
 *
 * La distincion que importa no es "fallo o no fallo" sino QUE CLASE de fallo,
 * porque cada una pide lo contrario de la otra:
 *
 *   - Un 429 quiere que se espere lo que la plataforma dice, ni mas ni menos.
 *   - Un 401 quiere que se pare del todo: reintentar con un token revocado no lo
 *     revive y encadena peticiones fallidas contra la API, que es justo el
 *     patron por el que las plataformas banean.
 *   - Un 400 por un texto invalido quiere que NO se reintente: el mismo texto
 *     volvera a fallar las cinco veces, gastando cuota para nada.
 *   - Un 503 si quiere reintento con espera creciente.
 *
 * Tratarlos igual convierte una incidencia menor en una cuenta baneada.
 */

export type FailureKind =
  | 'rate_limited'
  | 'auth_revoked'
  | 'invalid_content'
  | 'transient'
  | 'permanent';

export interface FailureVerdict {
  kind: FailureKind;
  /** Segundos que la plataforma pidio esperar, si lo dijo. */
  retryAfterSeconds: number | null;
}

export class PublishError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

/** Espera maxima. Un dia entero de espera es un trabajo abandonado, no aplazado. */
export const MAX_BACKOFF_SECONDS = 3600;
/** Primer escalon de la espera exponencial. */
export const BASE_BACKOFF_SECONDS = 60;

/**
 * Lee `Retry-After`, que llega en dos formatos segun la plataforma: segundos
 * ("120") o fecha HTTP ("Wed, 01 Apr 2026 12:05:00 GMT"). Soportar solo el
 * primero hace que con el segundo se caiga al calculo propio, que casi siempre
 * espera de menos y se gana otro 429.
 */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | null {
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(seconds, 0) : null;
  }

  const target = Date.parse(trimmed);
  if (Number.isNaN(target)) return null;

  return Math.max(Math.ceil((target - now.getTime()) / 1000), 0);
}

function headerValue(headers: Headers | Record<string, string> | undefined, name: string): string | null {
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get(name);

  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return null;
}

/**
 * Espera que pide el cuerpo de la respuesta.
 *
 * Telegram no usa `Retry-After`: manda `{ok:false, parameters:{retry_after:N}}`.
 * Mirar solo la cabecera deja pasar el unico dato fiable que da.
 */
function retryAfterFromBody(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;

  const parameters = (body as Record<string, unknown>).parameters;
  if (typeof parameters !== 'object' || parameters === null) return null;

  const value = (parameters as Record<string, unknown>).retry_after;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : null;
}

export function classifyResponse(input: {
  status: number;
  headers?: Headers | Record<string, string>;
  body?: unknown;
  now?: Date;
}): FailureVerdict {
  const { status } = input;
  const now = input.now ?? new Date();

  if (status === 429) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds:
        parseRetryAfter(headerValue(input.headers, 'retry-after'), now) ??
        retryAfterFromBody(input.body),
    };
  }

  // 403 entra aqui junto al 401 porque en la practica significa lo mismo: la
  // cuenta fue suspendida, el bot expulsado del canal o el permiso retirado.
  // Ninguna de esas tres se arregla reintentando.
  if (status === 401 || status === 403) {
    return { kind: 'auth_revoked', retryAfterSeconds: null };
  }

  // 404: el canal o el destino ya no existe. Tampoco vuelve solo.
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return { kind: 'invalid_content', retryAfterSeconds: null };
  }

  if (status === 408 || status === 425 || status >= 500) {
    return { kind: 'transient', retryAfterSeconds: null };
  }

  return { kind: 'permanent', retryAfterSeconds: null };
}

/** True si el fallo merece otro intento. */
export function isRetryable(kind: FailureKind): boolean {
  return kind === 'rate_limited' || kind === 'transient';
}

/**
 * True si el fallo debe parar TODOS los envios de ese perfil hacia esa red.
 *
 * Solo el token revocado. Un 429 es pasajero y un texto invalido afecta a una
 * publicacion concreta; suspender por cualquiera de los dos pararia la cuenta
 * entera por un problema de una sola publicacion.
 */
export function shouldSuspendProfile(kind: FailureKind): boolean {
  return kind === 'auth_revoked';
}

/**
 * Segundos de espera antes del siguiente intento.
 *
 * Con un 429 se respeta lo que pidio la plataforma y se le suma un margen
 * pequeno: volver exactamente en el segundo indicado, con varios workers a la
 * vez, es pedir otro 429.
 *
 * El azar entra por parametro para que las pruebas sean deterministas. Sin
 * dispersion, cien trabajos que fallan por el mismo corte vuelven todos en el
 * mismo instante y repiten el corte.
 */
export function backoffSeconds(input: {
  attempt: number;
  kind: FailureKind;
  retryAfterSeconds?: number | null;
  random?: () => number;
}): number {
  if (!isRetryable(input.kind)) return 0;

  const random = input.random ?? Math.random;
  const attempt = Math.max(input.attempt, 1);

  if (input.kind === 'rate_limited') {
    const requested = input.retryAfterSeconds ?? BASE_BACKOFF_SECONDS;
    // El margen se suma, nunca se resta: por debajo de lo pedido es desobedecer.
    const margin = Math.round(random() * 10);
    return Math.min(Math.max(requested, 1) + margin, MAX_BACKOFF_SECONDS);
  }

  const exponential = BASE_BACKOFF_SECONDS * 2 ** (attempt - 1);
  // Dispersion de +/-20% alrededor del escalon.
  const jittered = exponential * (0.8 + random() * 0.4);
  return Math.min(Math.max(Math.round(jittered), 1), MAX_BACKOFF_SECONDS);
}

export type RecoveryAction =
  /** Volver a intentarlo mas tarde. */
  | { action: 'defer'; delaySeconds: number }
  /** Parar los envios de ese perfil a esa red y dar el trabajo por muerto. */
  | { action: 'suspend'; delaySeconds: 0 }
  /** Dar el trabajo por muerto sin suspender nada mas. */
  | { action: 'kill'; delaySeconds: 0 };

/**
 * Que hacer con un trabajo que fallo.
 *
 * Reune en un solo sitio, y en codigo puro, las tres reglas del motor:
 *
 *   429  -> esperar lo que dijo la plataforma y reintentar.
 *   401  -> suspender el perfil en esa red y no reintentar.
 *   resto -> reintentar con espera creciente, o morir si no tiene arreglo.
 *
 * Tenerlo aparte del worker permite probar las tres sin base, sin red y sin
 * esperar de verdad los sesenta segundos.
 */
export function decideRecovery(input: {
  kind: FailureKind;
  attempt: number;
  retryAfterSeconds?: number | null;
  random?: () => number;
}): RecoveryAction {
  if (shouldSuspendProfile(input.kind)) {
    return { action: 'suspend', delaySeconds: 0 };
  }

  if (!isRetryable(input.kind)) {
    return { action: 'kill', delaySeconds: 0 };
  }

  return { action: 'defer', delaySeconds: backoffSeconds(input) };
}
