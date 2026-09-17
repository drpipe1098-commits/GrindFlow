/**
 * Pruebas de la tuberia de textos (Modulo 4).
 *
 * El foco esta en tres cosas, por este orden de importancia:
 *
 *   1. Que el filtro NO se pueda esquivar. Los terminos prohibidos se prueban
 *      ofuscados, que es como se intentan colar de verdad.
 *   2. Que el filtro no de falsos positivos. Un filtro que bloquea textos
 *      legitimos se acaba desactivando, y desactivado no protege de nada.
 *   3. Que la tuberia falle cerrada. Agotar los intentos no devuelve el mejor
 *      candidato: no devuelve ninguno.
 */
import { describe, expect, it } from 'vitest';
import {
  MockCaptionProvider,
  measureLength,
  produceCaption,
  validateCaption,
  validateManualCaption,
  type CaptionDraft,
  type CaptionProvider,
  type CaptionRequest,
  type PublishableCaption,
  type ValidationOptions,
} from '@/lib/captions';

const HOSTS = ['go.grindflow.link', 'onlyfans.com'] as const;

const opts = (overrides: Partial<ValidationOptions> = {}): ValidationOptions => ({
  platform: 'telegram',
  allowedHosts: HOSTS,
  ...overrides,
});

/** Codigos de los problemas encontrados, para aserciones legibles. */
const codes = (result: ReturnType<typeof validateCaption>): string[] =>
  result.ok ? [] : result.issues.map((i) => i.code);

describe('terminos prohibidos', () => {
  it('bloquea el termino escrito tal cual', () => {
    const result = validateCaption('Contenido teen nuevo', opts());
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('termino_prohibido');
  });

  it('bloquea el termino separado por puntos', () => {
    expect(validateCaption('Contenido t.e.e.n nuevo', opts()).ok).toBe(false);
  });

  it('bloquea el termino separado por espacios', () => {
    expect(validateCaption('Contenido t e e n nuevo', opts()).ok).toBe(false);
  });

  it('bloquea el termino en leet', () => {
    expect(validateCaption('Contenido t33n nuevo', opts()).ok).toBe(false);
  });

  it('bloquea el termino con acentos añadidos', () => {
    expect(validateCaption('Contenido téén nuevo', opts()).ok).toBe(false);
  });

  it('bloquea el termino partido con caracteres invisibles', () => {
    const conInvisible = 'Contenido te​en nuevo';
    const result = validateCaption(conInvisible, opts());
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('caracteres_invisibles');
  });

  it('bloquea terminos de no consentimiento', () => {
    expect(validateCaption('Video filtrado de anoche', opts()).ok).toBe(false);
  });

  it('no se puede desactivar por configuracion', () => {
    // No existe ninguna opcion que los permita: la lista dura no es parametrizable.
    const result = validateCaption('teen', opts({ extraBannedTerms: [] }));
    expect(result.ok).toBe(false);
  });

  it('aplica tambien los terminos vetados por la organizacion', () => {
    const result = validateCaption('Promo con descuento', opts({ extraBannedTerms: ['descuento'] }));
    expect(codes(result)).toContain('termino_prohibido');
  });
});

describe('sin falsos positivos', () => {
  it('no confunde "canteen" con el termino que contiene', () => {
    // La frontera de palabra es lo que separa un filtro util de uno inservible.
    const result = validateCaption('Nos vimos en la canteen del hotel', opts());
    expect(result.ok).toBe(true);
  });

  it('no confunde "Menorca" con "menor"', () => {
    expect(validateCaption('Sesion nueva desde Menorca', opts()).ok).toBe(true);
  });

  it('no lee "listo.Mira" como un dominio', () => {
    const result = validateCaption('Ya esta listo.Mira el set completo', opts());
    expect(result.ok).toBe(true);
  });

  it('acepta un texto normal con su enlace', () => {
    const result = validateCaption(
      'Set nuevo recien subido. Todo aqui https://go.grindflow.link/alfa-01',
      opts(),
    );
    expect(result.ok).toBe(true);
  });
});

describe('longitud por plataforma', () => {
  it('rechaza un texto que excede el limite de X', () => {
    const result = validateCaption('a'.repeat(281), opts({ platform: 'x' }));
    expect(codes(result)).toContain('demasiado_largo');
  });

  it('cuenta cada URL como 23 caracteres en X', () => {
    // X reescribe todo enlace a t.co: medir la URL real rechazaria textos que caben.
    const urlLarga = `https://go.grindflow.link/${'b'.repeat(200)}`;
    expect(measureLength(`Mira ${urlLarga}`, 'x')).toBe('Mira '.length + 23);
  });

  it('acepta en X un texto cuya URL larga cabe por el peso fijo', () => {
    const result = validateCaption(
      `Set nuevo https://go.grindflow.link/${'c'.repeat(150)}`,
      opts({ platform: 'x' }),
    );
    expect(result.ok).toBe(true);
  });

  it('mide los emoji como un solo caracter', () => {
    // Con .length un emoji suma 2 y rechazaria textos validos.
    expect(measureLength('🔥', 'telegram')).toBe(1);
  });

  it('cada plataforma tiene su propio limite', () => {
    const texto = 'd'.repeat(290);
    expect(validateCaption(texto, opts({ platform: 'x' })).ok).toBe(false);
    expect(validateCaption(texto, opts({ platform: 'telegram' })).ok).toBe(true);
  });
});

describe('enlaces', () => {
  it('acepta un destino verificado', () => {
    expect(validateCaption('Aqui https://onlyfans.com/alfa_uno', opts()).ok).toBe(true);
  });

  it('acepta un subdominio del destino verificado', () => {
    expect(validateCaption('Aqui https://www.onlyfans.com/alfa_uno', opts()).ok).toBe(true);
  });

  it('rechaza un destino que no esta verificado', () => {
    const result = validateCaption('Aqui https://sitio-raro.com/x', opts());
    expect(codes(result)).toContain('url_destino_no_permitido');
  });

  it('rechaza http sin cifrar', () => {
    const result = validateCaption('Aqui http://onlyfans.com/alfa_uno', opts());
    expect(codes(result)).toContain('url_sin_https');
  });

  it('rechaza el truco de credenciales antes del dominio', () => {
    // Parece onlyfans.com pero apunta a sitio-del-atacante.com.
    const result = validateCaption(
      'Aqui https://onlyfans.com@sitio-del-atacante.com/x',
      opts(),
    );
    expect(codes(result)).toContain('url_ofuscada');
  });

  it('rechaza punycode', () => {
    const result = validateCaption('Aqui https://xn--onlyfns-hwa.com/x', opts());
    expect(codes(result)).toContain('url_ofuscada');
  });

  it('rechaza una IP como destino', () => {
    const result = validateCaption('Aqui https://203.0.113.7/x', opts());
    expect(codes(result)).toContain('url_ofuscada');
  });

  it('rechaza acortadores de terceros', () => {
    // Romperia la atribucion: el clic se contaria en el panel de bit.ly.
    const result = validateCaption('Aqui https://bit.ly/abc', opts());
    expect(codes(result)).toContain('acortador_de_terceros');
  });

  it('rechaza un dominio escrito sin esquema', () => {
    const result = validateCaption('Entra en onlyfans.com/alfa_uno', opts());
    expect(codes(result)).toContain('dominio_sin_esquema');
  });

  it('rechaza mas enlaces de los permitidos', () => {
    const result = validateCaption(
      'Uno https://go.grindflow.link/a dos https://go.grindflow.link/b',
      opts({ platform: 'x' }),
    );
    expect(codes(result)).toContain('demasiados_enlaces');
  });

  it('exige el enlace cuando la campana lo requiere', () => {
    const result = validateCaption('Set nuevo sin enlace', opts({ requireLink: true }));
    expect(codes(result)).toContain('enlace_requerido_ausente');
  });

  it('tolera la puntuacion pegada al final de la URL', () => {
    const result = validateCaption('Mira https://go.grindflow.link/alfa-01.', opts());
    expect(result.ok).toBe(true);
  });
});

describe('hashtags, menciones y penalizaciones', () => {
  it('rechaza demasiados hashtags', () => {
    const result = validateCaption('Set #a #b #c #d nuevo', opts({ platform: 'x' }));
    expect(codes(result)).toContain('demasiados_hashtags');
  });

  it('un termino penalizado avisa pero no bloquea', () => {
    // Recorta alcance, no es ilegal: la decision es de la agencia.
    const result = validateCaption('Mira mi onlyfans', opts({ platform: 'x' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.code)).toContain('termino_penalizado');
    }
  });

  it('avisa de menciones a handles ajenos', () => {
    const result = validateCaption('Con @otra_modelo hoy', opts({ ownHandle: 'alfa_uno' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.code)).toContain('mencion_ajena');
    }
  });

  it('no avisa del handle propio', () => {
    const result = validateCaption('Soy @alfa_uno', opts({ ownHandle: '@alfa_uno' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(0);
    }
  });
});

describe('todos los problemas de una vez', () => {
  it('reporta cada incumplimiento, no solo el primero', () => {
    // Devolver uno solo hace que el generador corrija ese y vuelva a fallar por
    // el siguiente, gastando una vuelta entera por hallazgo.
    const result = validateCaption('teen http://bit.ly/x #a #b #c #d', opts({ platform: 'x' }));
    const found = codes(result);
    expect(found).toContain('termino_prohibido');
    expect(found).toContain('url_sin_https');
    expect(found).toContain('acortador_de_terceros');
    expect(found).toContain('demasiados_hashtags');
  });
});

describe('tuberia completa', () => {
  const request = (overrides: Partial<CaptionRequest> = {}): CaptionRequest => ({
    platform: 'telegram',
    handle: 'alfa_uno',
    outfitTag: 'lenceria-roja',
    destinationUrl: 'https://go.grindflow.link/alfa-01',
    locale: 'es',
    maxLength: 1024,
    ...overrides,
  });

  it('devuelve un caption publicable con el proveedor simulado', async () => {
    const result = await produceCaption({
      request: request(),
      validation: opts(),
      provider: new MockCaptionProvider(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caption).toContain('go.grindflow.link');
      expect(result.attempts).toBe(1);
    }
  });

  it('falla cerrado cuando el proveedor insiste en texto invalido', async () => {
    // Lo importante no es que falle, sino que NO devuelva el texto de todas formas.
    const hostil: CaptionProvider = {
      name: 'hostil',
      async generate(): Promise<CaptionDraft> {
        return { text: 'contenido teen nuevo', provider: 'hostil' };
      },
    };

    const result = await produceCaption({
      request: request(),
      validation: opts(),
      provider: hostil,
      maxAttempts: 3,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(3);
      expect(result.history).toHaveLength(3);
      expect(result.issues.map((i) => i.code)).toContain('termino_prohibido');
      // No hay ninguna propiedad por la que se cuele el texto rechazado.
      expect(result).not.toHaveProperty('caption');
    }
  });

  it('reintenta y acepta el texto corregido', async () => {
    let llamadas = 0;
    const corrige: CaptionProvider = {
      name: 'corrige',
      async generate(): Promise<CaptionDraft> {
        llamadas += 1;
        return {
          text:
            llamadas === 1
              ? 'set teen nuevo https://go.grindflow.link/a'
              : 'set nuevo https://go.grindflow.link/a',
          provider: 'corrige',
        };
      },
    };

    const result = await produceCaption({
      request: request(),
      validation: opts(),
      provider: corrige,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
  });

  it('reinyecta los hallazgos al generador para que corrija', async () => {
    const recibidos: (readonly unknown[] | undefined)[] = [];
    const observador: CaptionProvider = {
      name: 'observador',
      async generate(req): Promise<CaptionDraft> {
        recibidos.push(req.avoid);
        return { text: 'teen', provider: 'observador' };
      },
    };

    await produceCaption({
      request: request(),
      validation: opts(),
      provider: observador,
      maxAttempts: 2,
    });

    expect(recibidos[0]).toEqual([]);
    // El segundo intento ya sabe por que fallo el primero.
    expect(recibidos[1]?.length).toBeGreaterThan(0);
  });

  it('respeta un solo intento cuando se pide', async () => {
    const result = await produceCaption({
      request: request(),
      validation: opts({ requireLink: true }),
      provider: {
        name: 'vacio',
        async generate() {
          return { text: 'sin enlace', provider: 'vacio' };
        },
      },
      maxAttempts: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.attempts).toBe(1);
  });

  it('un texto escrito a mano pasa por el mismo filtro', async () => {
    // Que lo escriba una persona del equipo no lo hace mas seguro.
    const result = validateManualCaption('Set teen nuevo', opts());
    expect(result.ok).toBe(false);
  });
});

describe('garantia de tipo: el filtro no se puede saltar', () => {
  it('solo el validador produce un caption publicable', () => {
    // Estas dos lineas son la prueba de verdad, y la comprueba el compilador,
    // no vitest: si la marca del tipo se debilitara, `npm run typecheck` fallaria
    // porque el @ts-expect-error se quedaria sin error que suprimir.
    // @ts-expect-error una cadena corriente no es un caption publicable
    const falso: PublishableCaption = 'texto que nunca paso por el filtro';
    expect(typeof falso).toBe('string');

    const result = validateCaption('Set nuevo https://go.grindflow.link/a', opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const valido: PublishableCaption = result.caption;
      expect(typeof valido).toBe('string');
    }
  });
});
