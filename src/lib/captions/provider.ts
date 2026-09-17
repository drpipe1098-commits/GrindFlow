import type { Platform } from '@/lib/database.types';
import type { CaptionIssue } from './validator';

/**
 * Capa de generacion — interfaz de servicio.
 *
 * Deliberadamente agnostica del proveedor. Lo que devuelve es un `string`
 * corriente, NUNCA un `PublishableCaption`: un proveedor no puede marcar su
 * propia salida como publicable, ni por error ni a proposito, porque el tipo
 * marcado solo lo produce el validador.
 *
 * Para conectar un proveedor real basta implementar esta interfaz y registrarlo
 * en `resolveCaptionProvider`. Nada mas del modulo cambia: la tuberia sigue
 * validando igual, porque no confia en el generador.
 */

export interface CaptionRequest {
  platform: Platform;
  /** Handle de la modelo, para que el texto lo incluya. */
  handle: string;
  /** Prenda o sesion, para dar contexto al texto. */
  outfitTag: string | null;
  /** Enlace rastreado que debe aparecer, si lo hay. */
  destinationUrl: string | null;
  locale: 'es' | 'en';
  tone?: 'sugerente' | 'directo' | 'juguetona' | 'exclusivo';
  /** Longitud maxima util, ya descontado lo que ocupara el enlace. */
  maxLength: number;
  /**
   * Hallazgos del intento anterior. La tuberia los reinyecta para que el
   * proveedor corrija en vez de repetir el mismo fallo.
   */
  avoid?: readonly CaptionIssue[];
}

export interface CaptionDraft {
  /** Texto propuesto, SIN validar. */
  text: string;
  provider: string;
  model?: string;
}

export interface CaptionProvider {
  readonly name: string;
  generate(request: CaptionRequest): Promise<CaptionDraft>;
}

/**
 * Proveedor de relleno mientras no hay credenciales.
 *
 * Es determinista a proposito: sin llamadas de red y con la misma salida para
 * la misma entrada, de modo que las pruebas de la tuberia comprueban la tuberia
 * y no la creatividad de un modelo.
 *
 * Tambien reacciona a `avoid`, para que el bucle de reintento se pueda probar
 * de verdad: si el intento anterior fallo por longitud, acorta; si fallo por un
 * termino, cambia de plantilla.
 */
export class MockCaptionProvider implements CaptionProvider {
  readonly name = 'mock';

  private readonly templates: Record<'es' | 'en', string[]> = {
    es: [
      'Set nuevo recien subido {outfit}. Todo el contenido aqui {url}',
      'Hoy me sentia distinta {outfit}. Mira el resto {url}',
      'Contenido nuevo esperandote {url}',
    ],
    en: [
      'New set just dropped {outfit}. Full content here {url}',
      'Feeling different today {outfit}. See the rest {url}',
      'New content waiting for you {url}',
    ],
  };

  async generate(request: CaptionRequest): Promise<CaptionDraft> {
    const templates = this.templates[request.locale];
    // Cambia de plantilla en cada reintento; la ultima es la mas corta y sobria,
    // que es justamente la que mas probabilidades tiene de pasar el filtro.
    const index = Math.min(request.avoid?.length ?? 0, templates.length - 1);
    const template = templates[index] ?? templates[0] ?? '{url}';

    const outfit =
      request.outfitTag === null ? '' : `con ${request.outfitTag.replace(/-/g, ' ')}`;

    const text = template
      .replace('{outfit}', outfit)
      .replace('{url}', request.destinationUrl ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    return { text, provider: this.name };
  }
}

/**
 * Resuelve el proveedor activo.
 *
 * Hoy devuelve siempre el simulado. Cuando haya credenciales, aqui se lee la
 * variable de entorno del proveedor y se devuelve su implementacion.
 *
 * Para conectar Claude: `npm install @anthropic-ai/sdk`, implementar
 * `CaptionProvider` llamando a `client.messages.create` con el modelo
 * `claude-opus-5`, y devolver el texto en `CaptionDraft.text`. La clave se lee
 * del entorno igual que el resto de secretos del proyecto, y NO se guarda en
 * `platform_credentials`: esa tabla es para las cuentas de publicacion de cada
 * organizacion, no para credenciales de infraestructura compartidas.
 *
 * Nota para quien lo implemente: el proveedor devuelve texto sin marcar y la
 * tuberia lo valida despues. No hay que anadir comprobaciones dentro del
 * proveedor ni intentar devolver un tipo publicable.
 */
export function resolveCaptionProvider(): CaptionProvider {
  return new MockCaptionProvider();
}
