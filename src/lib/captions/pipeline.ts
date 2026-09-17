import {
  MockCaptionProvider,
  resolveCaptionProvider,
  type CaptionProvider,
  type CaptionRequest,
} from './provider';
import {
  validateCaption,
  type CaptionIssue,
  type PublishableCaption,
  type ValidationOptions,
} from './validator';

/**
 * Tuberia de textos: generar -> validar -> reintentar -> fallar cerrado.
 *
 * El orden no es negociable. La validacion es siempre el ultimo paso y no hay
 * ninguna rama que devuelva un texto sin haber pasado por ella: el tipo de
 * retorno es `PublishableCaption`, que solo produce el validador.
 *
 * Fallar cerrado significa que agotar los intentos NO devuelve el mejor
 * candidato ni el ultimo: no devuelve ninguno. Un caption es prescindible; uno
 * malo publicado en la cuenta de una modelo, no.
 */

export interface ProduceCaptionOptions {
  request: CaptionRequest;
  validation: ValidationOptions;
  /** Por defecto, el que resuelva el entorno. */
  provider?: CaptionProvider;
  /**
   * Intentos de generacion antes de rendirse. Tres es el equilibrio observado:
   * el primero falla por longitud o por un termino, el segundo suele corregirlo,
   * y a partir del cuarto se gasta dinero sin mejorar.
   */
  maxAttempts?: number;
}

export interface CaptionAttempt {
  attempt: number;
  text: string;
  issues: CaptionIssue[];
}

export type ProduceCaptionResult =
  | {
      ok: true;
      caption: PublishableCaption;
      provider: string;
      attempts: number;
      warnings: CaptionIssue[];
    }
  | {
      ok: false;
      attempts: number;
      /** Hallazgos del ultimo intento. */
      issues: CaptionIssue[];
      /** Historial completo, para diagnosticar por que no se consiguio. */
      history: CaptionAttempt[];
    };

export async function produceCaption(
  options: ProduceCaptionOptions,
): Promise<ProduceCaptionResult> {
  const provider = options.provider ?? resolveCaptionProvider();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const history: CaptionAttempt[] = [];

  let lastIssues: CaptionIssue[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Los hallazgos del intento anterior viajan al generador para que corrija.
    const draft = await provider.generate({
      ...options.request,
      avoid: lastIssues,
    });

    const result = validateCaption(draft.text, options.validation);

    if (result.ok) {
      return {
        ok: true,
        caption: result.caption,
        provider: draft.provider,
        attempts: attempt,
        warnings: result.warnings,
      };
    }

    lastIssues = result.issues;
    history.push({ attempt, text: draft.text, issues: result.issues });
  }

  return { ok: false, attempts: maxAttempts, issues: lastIssues, history };
}

/**
 * Valida un texto escrito por una persona.
 *
 * Pasa por exactamente el mismo filtro que lo generado por el modelo. Que lo
 * haya escrito alguien del equipo no lo hace mas seguro: los enlaces mal
 * copiados y los textos que exceden el limite de X son errores humanos tipicos,
 * y los terminos prohibidos tampoco distinguen quien los teclea.
 */
export function validateManualCaption(text: string, validation: ValidationOptions) {
  return validateCaption(text, validation);
}

export { MockCaptionProvider };
