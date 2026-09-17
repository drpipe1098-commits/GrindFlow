import type { Platform } from '@/lib/database.types';

/**
 * Limites de formato por plataforma.
 *
 * Fuente: documentacion publica de cada plataforma en el momento de escribir
 * esto. Cambian; cuando cambien, se ajusta aqui y no en el validador.
 */
export interface PlatformRules {
  /** Longitud maxima del texto, ya medida segun `measureLength`. */
  maxLength: number;
  /** Enlaces permitidos en un mismo texto. */
  maxLinks: number;
  /** Hashtags permitidos. */
  maxHashtags: number;
  /**
   * Cuenta cada URL como un numero fijo de caracteres en vez de por su longitud
   * real. X reescribe todos los enlaces a t.co y cobra 23 caracteres pase lo que
   * pase, asi que medir la URL entera rechazaria textos que en realidad caben.
   */
  urlWeight: number | null;
}

export const PLATFORM_RULES: Record<Platform, PlatformRules> = {
  x: { maxLength: 280, maxLinks: 1, maxHashtags: 3, urlWeight: 23 },
  // Limite del pie de una foto o video, que es como se publican los teasers.
  // Un mensaje de solo texto admite 4096, pero no es el caso de uso.
  telegram: { maxLength: 1024, maxLinks: 3, maxHashtags: 5, urlWeight: null },
  reddit: { maxLength: 300, maxLinks: 1, maxHashtags: 0, urlWeight: null },
  bluesky: { maxLength: 300, maxLinks: 2, maxHashtags: 4, urlWeight: null },
  // Destino propio: sin algoritmo que complacer ni limite impuesto.
  webhook: { maxLength: 10_000, maxLinks: 10, maxHashtags: 30, urlWeight: null },
};

/** Patron de URL con esquema explicito. */
export const URL_PATTERN = /https?:\/\/[^\s<>"'()]+/gi;

/**
 * Dominio escrito sin esquema (`ejemplo.com/ruta`).
 *
 * Se detecta aparte porque cuenta como enlace para el limite de la plataforma
 * —los clientes lo convierten en enlace al publicar— pero no se puede validar
 * como URL, y sin esquema no hay forma de garantizar HTTPS.
 */
export const BARE_DOMAIN_PATTERN =
  /(?<![@\w/.])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^\s]*)?/gi;

/**
 * TLDs que se aceptan como dominio escrito sin esquema.
 *
 * Es una lista y no un `[a-z]{2,}` generico porque sin ella una frase con un
 * punto y sin espacio detras ("todo listo.Mira aqui") se lee como un dominio y
 * bloquea un texto perfectamente valido. Un filtro con falsos positivos se acaba
 * desactivando, que es la peor forma de perderlo.
 */
export const KNOWN_TLDS: readonly string[] = [
  'com', 'net', 'org', 'io', 'co', 'me', 'link', 'xyz', 'app', 'tv', 'cam',
  'to', 'gg', 'ly', 'info', 'biz', 'shop', 'store', 'site', 'online', 'live',
  'fans', 'adult', 'porn', 'es', 'mx', 'ar', 'cl', 'pe', 'us', 'uk', 'br', 'co.uk',
];

/** True si el candidato termina en un TLD conocido, con o sin ruta detras. */
export function looksLikeDomain(candidate: string): boolean {
  const host = candidate.split('/')[0] ?? '';
  const tld = host.split('.').pop()?.toLowerCase() ?? '';
  return KNOWN_TLDS.includes(tld);
}

export const HASHTAG_PATTERN = /(?<![\w#])#[\p{L}\p{N}_]+/gu;

export const MENTION_PATTERN = /(?<![\w@])@[a-zA-Z0-9_.]{2,30}/g;

/**
 * Longitud del texto tal y como la cuenta la plataforma.
 *
 * Se cuenta por puntos de codigo (`Array.from`) y no con `.length`, que mide
 * unidades UTF-16: un emoji suma 2 y una bandera hasta 8, asi que `.length`
 * rechazaria textos que la plataforma acepta sin problema.
 */
export function measureLength(text: string, platform: Platform): number {
  const rules = PLATFORM_RULES[platform];
  let measured = text;

  if (rules.urlWeight !== null) {
    measured = measured.replace(URL_PATTERN, '#'.repeat(rules.urlWeight));
  }

  return Array.from(measured).length;
}
