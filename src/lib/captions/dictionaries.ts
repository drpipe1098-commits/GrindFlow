import type { Platform } from '@/lib/database.types';

/**
 * Diccionarios del filtro estricto.
 *
 * Hay dos clases de termino y no conviene mezclarlas, porque el coste de
 * equivocarse es distinto en cada una:
 *
 *   PROHIBIDOS  — nunca salen, bajo ninguna configuracion. Son los que sugieren
 *                 minoria de edad, falta de consentimiento o parentesco. No es
 *                 una cuestion de alcance ni de shadowban: publicar eso expone
 *                 al estudio a un problema legal y a la retirada de la cuenta,
 *                 y ninguna agencia puede desactivarlos desde el panel.
 *
 *   PENALIZADOS — no son ilegales, pero las plataformas recortan el alcance de
 *                 los posts que los llevan. Dependen de la plataforma y cambian
 *                 con sus politicas, asi que van separados y son revisables.
 */

/**
 * Terminos que sugieren minoria de edad. Se comprueban con tolerancia a
 * separadores y leet (ver normalize.ts), porque escribirlos ofuscados es
 * precisamente como se intenta colarlos.
 */
export const MINOR_CODED_TERMS: readonly string[] = [
  'teen',
  'teens',
  'teenager',
  'preteen',
  'underage',
  'minor',
  'jailbait',
  'barely legal',
  'schoolgirl',
  'school girl',
  'highschool',
  'high school',
  'colegiala',
  'menor',
  'menores',
  'nina',
  'ninas',
  'adolescente',
  'lolita',
  'loli',
  'kiddie',
  'child',
  'kid',
  'nino',
  'baby girl',
  'toddler',
];

/** Terminos que sugieren falta de consentimiento. */
export const NON_CONSENT_TERMS: readonly string[] = [
  'rape',
  'raped',
  'violacion',
  'violada',
  'nonconsent',
  'non consent',
  'sin consentimiento',
  'drugged',
  'drogada',
  'unconscious',
  'inconsciente',
  'forced',
  'forzada',
  'hidden cam',
  'hiddencam',
  'camara oculta',
  'spycam',
  'revenge porn',
  'leaked',
  'filtrado',
  'filtrados',
];

/** Terminos que sugieren parentesco. */
export const INCEST_CODED_TERMS: readonly string[] = [
  'incest',
  'incesto',
  'stepsister',
  'stepdaughter',
  'hermanastra',
  'hijastra',
  'daddy issues',
  'family taboo',
];

/**
 * Lista dura. El validador la aplica siempre y no admite excepciones por
 * configuracion: no existe ningun parametro que la desactive.
 */
export const FORBIDDEN_TERMS: readonly string[] = [
  ...MINOR_CODED_TERMS,
  ...NON_CONSENT_TERMS,
  ...INCEST_CODED_TERMS,
];

/**
 * Terminos que recortan alcance, por plataforma.
 *
 * Son heuristicas observadas, no reglas publicadas: ninguna plataforma documenta
 * su lista. Por eso viven aqui, separados y faciles de ajustar cuando cambie el
 * comportamiento observado, en vez de incrustados en el validador.
 */
export const SHADOWBAN_TERMS: Record<Platform, readonly string[]> = {
  // X degrada los posts que empujan trafico fuera y los que nombran plataformas
  // de pago directamente.
  x: [
    'onlyfans',
    'only fans',
    'fansly',
    'link in bio',
    'link en bio',
    'dm me',
    'dm para',
    'cashapp',
    'venmo',
    'paypal',
    'free nudes',
    'nudes gratis',
    'sexo',
    'porn',
    'xxx',
  ],
  // Reddit expulsa por spam y por saltarse las reglas de cada subreddit.
  reddit: [
    'upvote',
    'karma',
    'dm me',
    'check my profile',
    'mira mi perfil',
    'onlyfans',
    'only fans',
    'free trial',
    'prueba gratis',
  ],
  // Telegram es la mas permisiva: casi todo lo que penaliza es spam evidente.
  telegram: ['bot gratis', 'click aqui ahora', 'gana dinero', 'crypto'],
  bluesky: ['onlyfans', 'only fans', 'link in bio', 'dm me'],
  // Un webhook va a un destino propio: no hay algoritmo al que caerle mal.
  webhook: [],
};

/**
 * Acortadores de terceros.
 *
 * Nunca deben aparecer en un caption: rompen la atribucion del Modulo 6 (el
 * clic se cuenta en el panel del acortador ajeno, no en el nuestro) y ademas
 * varias plataformas los penalizan por ocultar el destino real.
 */
export const THIRD_PARTY_SHORTENERS: readonly string[] = [
  'bit.ly',
  'tinyurl.com',
  'goo.gl',
  't.co',
  'ow.ly',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'is.gd',
  'shorturl.at',
  'linktr.ee',
  'beacons.ai',
];
