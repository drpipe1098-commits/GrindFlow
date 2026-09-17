/**
 * Pruebas del motor de publicacion.
 *
 * El nucleo de lo que se prueba aqui es la CLASIFICACION de fallos, porque cada
 * clase pide lo contrario de la otra: un 429 quiere esperar lo que la plataforma
 * dijo, un 401 quiere parar del todo, y un 400 no quiere reintento ninguno.
 * Tratarlos igual convierte una incidencia menor en una cuenta baneada, y eso no
 * se descubre hasta que ya paso.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCaption, type PublishableCaption } from '@/lib/captions';
import {
  MAX_BACKOFF_SECONDS,
  backoffSeconds,
  classifyResponse,
  decideRecovery,
  isRetryable,
  parseRetryAfter,
  shouldSuspendProfile,
} from '@/lib/publishing/errors';
import { mediaExceedsLimits, type PublishMedia } from '@/lib/publishing/publisher';
import { implementedPlatforms, publisherFor } from '@/lib/publishing/registry';
import { signPayload } from '@/lib/publishing/webhook';
import { telegramPublisher } from '@/lib/publishing/telegram';

/** Texto ya validado: el unico modo de obtener el tipo que exige el publicador. */
function caption(text = 'Set nuevo disponible'): PublishableCaption {
  const result = validateCaption(text, { platform: 'telegram', allowedHosts: [] });
  if (!result.ok) throw new Error(`el texto de prueba no paso el filtro: ${text}`);
  return result.caption;
}

const AHORA = new Date('2026-04-01T12:00:00Z');
/** Azar fijo, para que las esperas sean comprobables. */
const sinAzar = () => 0;

describe('lectura de Retry-After', () => {
  it('lee segundos', () => {
    expect(parseRetryAfter('120', AHORA)).toBe(120);
  });

  it('lee una fecha HTTP', () => {
    // Varias plataformas usan este formato; soportar solo el numerico haria caer
    // al calculo propio, que casi siempre espera de menos y se gana otro 429.
    expect(parseRetryAfter('Wed, 01 Apr 2026 12:02:00 GMT', AHORA)).toBe(120);
  });

  it('una fecha ya pasada no pide esperar', () => {
    expect(parseRetryAfter('Wed, 01 Apr 2026 11:58:00 GMT', AHORA)).toBe(0);
  });

  it('devuelve null con basura o ausencia', () => {
    expect(parseRetryAfter(null, AHORA)).toBeNull();
    expect(parseRetryAfter('', AHORA)).toBeNull();
    expect(parseRetryAfter('pronto', AHORA)).toBeNull();
  });
});

describe('clasificacion de respuestas', () => {
  it('429 con cabecera es limite de tasa', () => {
    const verdict = classifyResponse({
      status: 429,
      headers: { 'Retry-After': '45' },
      now: AHORA,
    });
    expect(verdict.kind).toBe('rate_limited');
    expect(verdict.retryAfterSeconds).toBe(45);
  });

  it('429 de Telegram trae la espera en el cuerpo', () => {
    // Telegram no usa Retry-After: manda parameters.retry_after. Mirar solo la
    // cabecera desperdicia el unico dato fiable que da.
    const verdict = classifyResponse({
      status: 429,
      body: { ok: false, parameters: { retry_after: 30 } },
      now: AHORA,
    });
    expect(verdict.kind).toBe('rate_limited');
    expect(verdict.retryAfterSeconds).toBe(30);
  });

  it('429 sin pista deja la espera al calculo propio', () => {
    expect(classifyResponse({ status: 429 }).retryAfterSeconds).toBeNull();
  });

  it('401 y 403 son credencial revocada', () => {
    // 403 entra aqui porque en la practica significa lo mismo: cuenta suspendida,
    // bot expulsado del canal o permiso retirado.
    expect(classifyResponse({ status: 401 }).kind).toBe('auth_revoked');
    expect(classifyResponse({ status: 403 }).kind).toBe('auth_revoked');
  });

  it('400, 404, 413 y 422 son contenido invalido', () => {
    for (const status of [400, 404, 413, 422]) {
      expect(classifyResponse({ status }).kind).toBe('invalid_content');
    }
  });

  it('408 y los 5xx son pasajeros', () => {
    for (const status of [408, 425, 500, 502, 503]) {
      expect(classifyResponse({ status }).kind).toBe('transient');
    }
  });

  it('lo demas es permanente', () => {
    expect(classifyResponse({ status: 418 }).kind).toBe('permanent');
  });

  it('acepta cabeceras como objeto sin distinguir mayusculas', () => {
    const verdict = classifyResponse({ status: 429, headers: { 'retry-after': '10' } });
    expect(verdict.retryAfterSeconds).toBe(10);
  });
});

describe('que se reintenta y que suspende', () => {
  it('solo el limite de tasa y lo pasajero se reintentan', () => {
    expect(isRetryable('rate_limited')).toBe(true);
    expect(isRetryable('transient')).toBe(true);
    expect(isRetryable('auth_revoked')).toBe(false);
    expect(isRetryable('invalid_content')).toBe(false);
    expect(isRetryable('permanent')).toBe(false);
  });

  it('solo la credencial revocada suspende el perfil', () => {
    // Suspender por un 429 pararia la cuenta entera por un problema pasajero.
    expect(shouldSuspendProfile('auth_revoked')).toBe(true);
    expect(shouldSuspendProfile('rate_limited')).toBe(false);
    expect(shouldSuspendProfile('invalid_content')).toBe(false);
    expect(shouldSuspendProfile('transient')).toBe(false);
  });
});

describe('calculo de la espera', () => {
  it('respeta lo que pidio la plataforma', () => {
    const espera = backoffSeconds({
      attempt: 1,
      kind: 'rate_limited',
      retryAfterSeconds: 300,
      random: sinAzar,
    });
    expect(espera).toBe(300);
  });

  it('nunca espera menos de lo pedido', () => {
    // Volver antes de tiempo es desobedecer, y se gana otro 429 mas largo.
    for (const azar of [0, 0.5, 0.99]) {
      const espera = backoffSeconds({
        attempt: 5,
        kind: 'rate_limited',
        retryAfterSeconds: 120,
        random: () => azar,
      });
      expect(espera).toBeGreaterThanOrEqual(120);
    }
  });

  it('anade un margen para que las replicas no vuelvan a la vez', () => {
    const conMargen = backoffSeconds({
      attempt: 1,
      kind: 'rate_limited',
      retryAfterSeconds: 100,
      random: () => 1,
    });
    expect(conMargen).toBeGreaterThan(100);
    expect(conMargen).toBeLessThanOrEqual(110);
  });

  it('crece exponencialmente en los fallos pasajeros', () => {
    const espera = (attempt: number) =>
      backoffSeconds({ attempt, kind: 'transient', random: () => 0.5 });

    expect(espera(1)).toBe(60);
    expect(espera(2)).toBe(120);
    expect(espera(3)).toBe(240);
    expect(espera(4)).toBe(480);
  });

  it('dispersa la espera alrededor del escalon', () => {
    // Sin dispersion, cien trabajos que fallan por el mismo corte vuelven todos
    // en el mismo instante y repiten el corte.
    const bajo = backoffSeconds({ attempt: 3, kind: 'transient', random: () => 0 });
    const alto = backoffSeconds({ attempt: 3, kind: 'transient', random: () => 1 });
    expect(bajo).toBe(192);
    expect(alto).toBe(288);
  });

  it('no supera el tope', () => {
    const espera = backoffSeconds({ attempt: 20, kind: 'transient', random: () => 1 });
    expect(espera).toBe(MAX_BACKOFF_SECONDS);
  });

  it('lo que no se reintenta no espera', () => {
    expect(backoffSeconds({ attempt: 1, kind: 'auth_revoked' })).toBe(0);
    expect(backoffSeconds({ attempt: 1, kind: 'invalid_content' })).toBe(0);
  });
});

describe('decision de recuperacion', () => {
  it('un 429 se aplaza con la espera pedida', () => {
    const decision = decideRecovery({
      kind: 'rate_limited',
      attempt: 2,
      retryAfterSeconds: 90,
      random: sinAzar,
    });
    expect(decision).toEqual({ action: 'defer', delaySeconds: 90 });
  });

  it('un 401 suspende el perfil en esa red', () => {
    expect(decideRecovery({ kind: 'auth_revoked', attempt: 1 })).toEqual({
      action: 'suspend',
      delaySeconds: 0,
    });
  });

  it('un contenido invalido se da por muerto sin reintentar', () => {
    // El mismo texto fallaria igual las cinco veces, gastando cuota de la API.
    expect(decideRecovery({ kind: 'invalid_content', attempt: 1 })).toEqual({
      action: 'kill',
      delaySeconds: 0,
    });
  });

  it('un fallo pasajero se aplaza con espera creciente', () => {
    const decision = decideRecovery({ kind: 'transient', attempt: 3, random: () => 0.5 });
    expect(decision.action).toBe('defer');
    expect(decision.delaySeconds).toBe(240);
  });
});

describe('limites de peso del destino', () => {
  const media = (type: 'image' | 'video', sizeBytes: number): PublishMedia => ({
    type,
    bytes: null,
    url: null,
    mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4',
    fileName: 'archivo',
    sizeBytes,
  });

  it('acepta lo que cabe', () => {
    expect(mediaExceedsLimits(media('image', 5_000_000), telegramPublisher.limits)).toBeNull();
    expect(mediaExceedsLimits(media('video', 40_000_000), telegramPublisher.limits)).toBeNull();
  });

  it('rechaza la foto que pasa del limite', () => {
    const motivo = mediaExceedsLimits(media('image', 12_000_000), telegramPublisher.limits);
    expect(motivo).toContain('11.4 MB');
    expect(motivo).toContain('10.0 MB');
  });

  it('aplica a cada tipo su propio limite', () => {
    // 40 MB pasan como video pero no como foto.
    expect(mediaExceedsLimits(media('video', 40_000_000), telegramPublisher.limits)).toBeNull();
    expect(mediaExceedsLimits(media('image', 40_000_000), telegramPublisher.limits)).not.toBeNull();
  });
});

describe('registro de publicadores', () => {
  it('hoy publican Telegram y el webhook', () => {
    expect(implementedPlatforms().sort()).toEqual(['telegram', 'webhook']);
  });

  it('los pendientes existen y fallan de forma predecible', async () => {
    // Existen para que el despachador no se rompa con un undefined al toparlos.
    for (const platform of ['x', 'reddit', 'bluesky'] as const) {
      const publisher = publisherFor(platform);
      expect(publisher.implemented).toBe(false);
      await expect(
        publisher.publish({
          caption: caption(),
          media: { type: 'image', bytes: null, url: null, mimeType: 'image/jpeg', fileName: 'a', sizeBytes: 1 },
          accountIdentifier: null,
          settings: {},
          secret: 'x',
        }),
      ).rejects.toThrow(/no esta implementado/);
    }
  });

  it('cada plataforma del enum tiene publicador', () => {
    for (const platform of ['telegram', 'webhook', 'x', 'reddit', 'bluesky'] as const) {
      expect(publisherFor(platform).platform).toBe(platform);
    }
  });
});

describe('firma del webhook', () => {
  it('produce el formato con momento y version', () => {
    const firma = signPayload('secreto', 1_800_000_000, '{"a":1}');
    expect(firma).toMatch(/^t=1800000000,v1=[a-f0-9]{64}$/);
  });

  it('es estable para la misma entrada', () => {
    expect(signPayload('s', 100, 'x')).toBe(signPayload('s', 100, 'x'));
  });

  it('cambia con el secreto, el cuerpo y el momento', () => {
    const base = signPayload('s1', 100, 'x');
    expect(signPayload('s2', 100, 'x')).not.toBe(base);
    expect(signPayload('s1', 100, 'y')).not.toBe(base);
    // El momento entra en la firma: sin el, quien capture una peticion valida
    // puede reenviarla cuando quiera.
    expect(signPayload('s1', 200, 'x')).not.toBe(base);
  });
});

describe('publicador de Telegram', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const media = (type: 'image' | 'video' = 'image', sizeBytes = 1000): PublishMedia => ({
    type,
    bytes: new Uint8Array(sizeBytes),
    url: null,
    mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4',
    fileName: type === 'image' ? 'foto.jpg' : 'video.mp4',
    sizeBytes,
  });

  function stubFetch(response: { status: number; body: unknown; headers?: Record<string, string> }) {
    const calls: { url: string; form: FormData }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, form: init.body as FormData });
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...response.headers },
      });
    });
    return calls;
  }

  it('manda foto con el texto y el canal', async () => {
    const calls = stubFetch({
      status: 200,
      body: { ok: true, result: { message_id: 42, chat: { username: 'canal_alfa' } } },
    });

    const outcome = await telegramPublisher.publish({
      caption: caption('Set nuevo disponible'),
      media: media('image'),
      accountIdentifier: '@canal_alfa',
      settings: {},
      secret: 'token-del-bot',
    });

    expect(calls[0]?.url).toContain('/bottoken-del-bot/sendPhoto');
    expect(calls[0]?.form.get('chat_id')).toBe('@canal_alfa');
    expect(calls[0]?.form.get('caption')).toBe('Set nuevo disponible');
    expect(outcome.externalId).toBe('42');
    expect(outcome.url).toBe('https://t.me/canal_alfa/42');
  });

  it('usa sendVideo para los videos', async () => {
    const calls = stubFetch({ status: 200, body: { ok: true, result: { message_id: 7 } } });

    await telegramPublisher.publish({
      caption: caption(),
      media: media('video'),
      accountIdentifier: '-1001234',
      settings: {},
      secret: 't',
    });

    expect(calls[0]?.url).toContain('/sendVideo');
    expect(calls[0]?.form.get('video')).toBeInstanceOf(Blob);
  });

  it('prefiere el chat_id de los ajustes sobre el identificador', async () => {
    const calls = stubFetch({ status: 200, body: { ok: true, result: { message_id: 1 } } });

    await telegramPublisher.publish({
      caption: caption(),
      media: media(),
      accountIdentifier: '@publico',
      settings: { chat_id: '-1009999' },
      secret: 't',
    });

    expect(calls[0]?.form.get('chat_id')).toBe('-1009999');
  });

  it('no devuelve enlace inventado para un canal privado', async () => {
    // Un canal sin `username` no tiene URL publica, y fabricar una seria peor
    // que no dar ninguna.
    stubFetch({ status: 200, body: { ok: true, result: { message_id: 9, chat: { id: -100 } } } });

    const outcome = await telegramPublisher.publish({
      caption: caption(),
      media: media(),
      accountIdentifier: '-100',
      settings: {},
      secret: 't',
    });

    expect(outcome.externalId).toBe('9');
    expect(outcome.url).toBeNull();
  });

  it('rechaza el archivo demasiado grande sin subirlo', async () => {
    // Subir cincuenta megas para recibir un 413 al final es tirar la subida.
    const calls = stubFetch({ status: 200, body: { ok: true } });

    await expect(
      telegramPublisher.publish({
        caption: caption(),
        media: media('image', 12 * 1_048_576),
        accountIdentifier: '@c',
        settings: {},
        secret: 't',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_content' });

    expect(calls).toHaveLength(0);
  });

  it('traduce el 429 con la espera que pide Telegram', async () => {
    stubFetch({
      status: 429,
      body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 25 } },
    });

    await expect(
      telegramPublisher.publish({
        caption: caption(),
        media: media(),
        accountIdentifier: '@c',
        settings: {},
        secret: 't',
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 25 });
  });

  it('traduce el 401 a credencial revocada', async () => {
    stubFetch({ status: 401, body: { ok: false, description: 'Unauthorized' } });

    await expect(
      telegramPublisher.publish({
        caption: caption(),
        media: media(),
        accountIdentifier: '@c',
        settings: {},
        secret: 't',
      }),
    ).rejects.toMatchObject({ kind: 'auth_revoked' });
  });

  it('falla si la credencial no dice a que canal publicar', async () => {
    stubFetch({ status: 200, body: { ok: true } });

    await expect(
      telegramPublisher.publish({
        caption: caption(),
        media: media(),
        accountIdentifier: null,
        settings: {},
        secret: 't',
      }),
    ).rejects.toThrow(/canal destino/);
  });
});
