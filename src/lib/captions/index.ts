/**
 * Superficie publica del modulo de textos (Modulo 4).
 *
 * El publicador debe importar de aqui. La regla que sostiene todo el modulo:
 * cualquier funcion que entregue texto al publicador devuelve
 * `PublishableCaption`, y ese tipo solo lo produce `validateCaption`. Un
 * `string` corriente no compila donde se espera un caption publicable.
 */
export {
  produceCaption,
  validateManualCaption,
  type CaptionAttempt,
  type ProduceCaptionOptions,
  type ProduceCaptionResult,
} from './pipeline';

export {
  captionText,
  validateCaption,
  type CaptionIssue,
  type CaptionIssueCode,
  type PublishableCaption,
  type ValidationOptions,
  type ValidationResult,
} from './validator';

export {
  MockCaptionProvider,
  resolveCaptionProvider,
  type CaptionDraft,
  type CaptionProvider,
  type CaptionRequest,
} from './provider';

export { PLATFORM_RULES, measureLength, type PlatformRules } from './platform-rules';

export {
  FORBIDDEN_TERMS,
  SHADOWBAN_TERMS,
  THIRD_PARTY_SHORTENERS,
} from './dictionaries';
