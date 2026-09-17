import type { Platform } from '@/lib/database.types';
import {
  FORBIDDEN_TERMS,
  SHADOWBAN_TERMS,
  THIRD_PARTY_SHORTENERS,
} from './dictionaries';
import { findTerms, hasInvisibleCharacters, stripInvisibleCharacters } from './normalize';
import {
  BARE_DOMAIN_PATTERN,
  HASHTAG_PATTERN,
  MENTION_PATTERN,
  PLATFORM_RULES,
  URL_PATTERN,
  looksLikeDomain,
  measureLength,
} from './platform-rules';

/**
 * Filtro estricto de textos — ultima barrera antes del publicador.
 *
 * La garantia arquitectonica del modulo esta en el tipo `PublishableCaption`.
 * Es una cadena con una marca que SOLO puede poner la funcion `mint` de este
 * archivo, que es privada del modulo. El publicador acepta unicamente ese tipo,
 * asi que un texto que venga del LLM —o de cualquier otro sitio— no compila
 * como argumento hasta haber pasado por aqui.
 *
 * No es una convencion que haya que recordar ni una comprobacion que se pueda
 * olvidar en una rama: es el compilador quien lo impide. Una funcion que
 * devolviera `string` habria dejado el asunto en manos de la disciplina de quien
 * escriba el siguiente publicador.
 */

declare const publishableBrand: unique symbol;

/** Texto que ya paso el filtro. Solo `validateCaption` puede producirlo. */
export type PublishableCaption = string & { readonly [publishableBrand]: true };

export type CaptionIssueCode =
  | 'vacio'
  | 'demasiado_largo'
  | 'termino_prohibido'
  | 'termino_penalizado'
  | 'caracteres_invisibles'
  | 'url_sin_https'
  | 'url_malformada'
  | 'url_destino_no_permitido'
  | 'url_ofuscada'
  | 'acortador_de_terceros'
  | 'dominio_sin_esquema'
  | 'demasiados_enlaces'
  | 'demasiados_hashtags'
  | 'mencion_ajena'
  | 'enlace_requerido_ausente';

export interface CaptionIssue {
  code: CaptionIssueCode;
  /** `error` bloquea la publicacion; `warning` solo informa. */
  severity: 'error' | 'warning';
  message: string;
  /** Fragmento exacto que disparo el hallazgo. Sirve para corregir y para reportar. */
  evidence?: string;
}

export interface ValidationOptions {
  platform: Platform;
  /**
   * Hosts a los que se permite enlazar. Es el "verified URL target" del PRD:
   * el dominio del acortador propio y los destinos que la agencia haya dado de
   * alta. Todo lo demas se rechaza.
   */
  allowedHosts: readonly string[];
  /** Exige que el texto lleve al menos un enlace. */
  requireLink?: boolean;
  /** Handle de la modelo. Las menciones a otros handles se marcan. */
  ownHandle?: string;
  /** Terminos adicionales que esta organizacion quiere vetar. */
  extraBannedTerms?: readonly string[];
}

export type ValidationResult =
  | {
      ok: true;
      caption: PublishableCaption;
      /** Hallazgos no bloqueantes. El texto es publicable pese a ellos. */
      warnings: CaptionIssue[];
    }
  | { ok: false; issues: CaptionIssue[] };

/**
 * Unico punto del sistema que marca un texto como publicable.
 *
 * Privada a proposito: no se exporta. Si se exportara, cualquiera podria marcar
 * un texto sin validarlo y la garantia del tipo dejaria de valer.
 */
function mint(text: string): PublishableCaption {
  return text as PublishableCaption;
}

function hostMatches(host: string, allowed: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedAllowed = allowed.toLowerCase();
  return (
    normalizedHost === normalizedAllowed ||
    normalizedHost.endsWith(`.${normalizedAllowed}`)
  );
}

/** Revisa una URL suelta y devuelve los problemas que tenga. */
function inspectUrl(raw: string, allowedHosts: readonly string[]): CaptionIssue[] {
  const issues: CaptionIssue[] = [];
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return [
      {
        code: 'url_malformada',
        severity: 'error',
        message: 'El enlace no es una URL valida.',
        evidence: raw,
      },
    ];
  }

  if (url.protocol !== 'https:') {
    issues.push({
      code: 'url_sin_https',
      severity: 'error',
      message: 'Los enlaces deben ir por HTTPS.',
      evidence: raw,
    });
  }

  // `https://destino-confiable.com@sitio-del-atacante.com` apunta al segundo
  // host, no al primero, pero a simple vista parece el primero. Es el engano
  // clasico de phishing y no hay ningun motivo legitimo para usarlo aqui.
  if (url.username !== '' || url.password !== '') {
    issues.push({
      code: 'url_ofuscada',
      severity: 'error',
      message: 'El enlace lleva credenciales antes del dominio y oculta su destino real.',
      evidence: raw,
    });
  }

  // Punycode permite dominios que se leen igual que el legitimo con letras de
  // otro alfabeto.
  if (url.hostname.includes('xn--')) {
    issues.push({
      code: 'url_ofuscada',
      severity: 'error',
      message: 'El dominio usa punycode y puede suplantar visualmente a otro.',
      evidence: url.hostname,
    });
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(':')) {
    issues.push({
      code: 'url_ofuscada',
      severity: 'error',
      message: 'El enlace apunta a una IP en vez de a un dominio.',
      evidence: url.hostname,
    });
  }

  if (THIRD_PARTY_SHORTENERS.some((short) => hostMatches(url.hostname, short))) {
    issues.push({
      code: 'acortador_de_terceros',
      severity: 'error',
      message:
        'Acortador ajeno: el clic se contaria en su panel y no en el nuestro, ' +
        'y varias plataformas lo penalizan por ocultar el destino.',
      evidence: url.hostname,
    });
  }

  if (!allowedHosts.some((allowed) => hostMatches(url.hostname, allowed))) {
    issues.push({
      code: 'url_destino_no_permitido',
      severity: 'error',
      message: `El destino ${url.hostname} no esta en la lista de destinos verificados.`,
      evidence: url.hostname,
    });
  }

  return issues;
}

/**
 * Valida un texto. Es el unico camino para obtener un `PublishableCaption`.
 *
 * Nunca corta al primer problema: devuelve todos. Un generador que recibe un
 * solo motivo corrige ese y vuelve a fallar por el siguiente, gastando una
 * vuelta entera por cada hallazgo.
 */
export function validateCaption(text: string, options: ValidationOptions): ValidationResult {
  const issues: CaptionIssue[] = [];
  const warnings: CaptionIssue[] = [];
  const rules = PLATFORM_RULES[options.platform];

  // Los caracteres invisibles se limpian, pero tambien se reportan: aparecen
  // justo cuando alguien intenta partir una palabra vetada por dentro.
  if (hasInvisibleCharacters(text)) {
    issues.push({
      code: 'caracteres_invisibles',
      severity: 'error',
      message:
        'El texto contiene caracteres invisibles, que sirven para partir ' +
        'palabras y esquivar filtros.',
    });
  }

  const cleaned = stripInvisibleCharacters(text).trim();

  if (cleaned.length === 0) {
    return {
      ok: false,
      issues: [{ code: 'vacio', severity: 'error', message: 'El texto esta vacio.' }],
    };
  }

  // --- Longitud --------------------------------------------------------------
  const length = measureLength(cleaned, options.platform);
  if (length > rules.maxLength) {
    issues.push({
      code: 'demasiado_largo',
      severity: 'error',
      message: `${length} caracteres para un maximo de ${rules.maxLength} en ${options.platform}.`,
    });
  }

  // --- Terminos prohibidos ---------------------------------------------------
  // Esta comprobacion no tiene interruptor. No depende de la plataforma ni de
  // la configuracion de la organizacion.
  const forbidden = findTerms(cleaned, FORBIDDEN_TERMS);
  for (const term of forbidden) {
    issues.push({
      code: 'termino_prohibido',
      severity: 'error',
      message: `Termino prohibido: "${term}". No se publica bajo ninguna configuracion.`,
      evidence: term,
    });
  }

  const extra = findTerms(cleaned, options.extraBannedTerms ?? []);
  for (const term of extra) {
    issues.push({
      code: 'termino_prohibido',
      severity: 'error',
      message: `Termino vetado por la organizacion: "${term}".`,
      evidence: term,
    });
  }

  // --- Terminos penalizados (no bloquean) ------------------------------------
  const penalized = findTerms(cleaned, SHADOWBAN_TERMS[options.platform]);
  for (const term of penalized) {
    warnings.push({
      code: 'termino_penalizado',
      severity: 'warning',
      message: `"${term}" suele recortar el alcance en ${options.platform}.`,
      evidence: term,
    });
  }

  // --- Enlaces ---------------------------------------------------------------
  const urls = cleaned.match(URL_PATTERN) ?? [];
  for (const url of urls) {
    // La puntuacion final de una frase se pega a la URL al extraerla.
    issues.push(...inspectUrl(url.replace(/[.,;:!?]+$/, ''), options.allowedHosts));
  }

  // Dominios escritos sin esquema: cuentan como enlace porque los clientes los
  // convierten al publicar, pero no se puede garantizar que vayan por HTTPS.
  BARE_DOMAIN_PATTERN.lastIndex = 0;
  const bareDomains = (cleaned.replace(URL_PATTERN, ' ').match(BARE_DOMAIN_PATTERN) ?? [])
    // Una frase que termina en punto seguido de palabra ("listo.Mira") no es un
    // dominio: se exige un TLD de la lista conocida.
    .filter(looksLikeDomain);

  for (const domain of bareDomains) {
    issues.push({
      code: 'dominio_sin_esquema',
      severity: 'error',
      message: `"${domain}" es un enlace sin https:// y no se puede verificar su destino.`,
      evidence: domain,
    });
  }

  const linkCount = urls.length + bareDomains.length;
  if (linkCount > rules.maxLinks) {
    issues.push({
      code: 'demasiados_enlaces',
      severity: 'error',
      message: `${linkCount} enlaces para un maximo de ${rules.maxLinks} en ${options.platform}.`,
    });
  }

  if (options.requireLink === true && linkCount === 0) {
    issues.push({
      code: 'enlace_requerido_ausente',
      severity: 'error',
      message: 'El texto debe incluir el enlace rastreado de la campana.',
    });
  }

  // --- Hashtags y menciones --------------------------------------------------
  const hashtags = cleaned.match(HASHTAG_PATTERN) ?? [];
  if (hashtags.length > rules.maxHashtags) {
    issues.push({
      code: 'demasiados_hashtags',
      severity: 'error',
      message: `${hashtags.length} hashtags para un maximo de ${rules.maxHashtags} en ${options.platform}.`,
    });
  }

  if (options.ownHandle !== undefined) {
    const own = options.ownHandle.replace(/^@/, '').toLowerCase();
    for (const mention of cleaned.match(MENTION_PATTERN) ?? []) {
      if (mention.slice(1).toLowerCase() !== own) {
        warnings.push({
          code: 'mencion_ajena',
          severity: 'warning',
          message: `El texto menciona a ${mention}, que no es el handle de la modelo.`,
          evidence: mention,
        });
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, caption: mint(cleaned), warnings };
}

/**
 * Texto plano de un caption ya validado.
 *
 * `PublishableCaption` ya ES una cadena en ejecucion; esto existe para los
 * puntos donde hace falta pasarlo a una API que espera `string` sin arrastrar la
 * marca, y deja constancia en el codigo de que ahi se sale del tipo seguro.
 */
export function captionText(caption: PublishableCaption): string {
  return caption;
}
