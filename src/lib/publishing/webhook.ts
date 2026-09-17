import 'server-only';

import { createHmac } from 'node:crypto';
import { PublishError, classifyResponse } from './errors';
import type { PlatformPublisher, PublishOutcome, PublishRequest } from './publisher';

/**
 * Publicador de webhook generico.
 *
 * Es la valvula de escape del Modulo 5: permite conectar cualquier destino
 * —un flujo de n8n, un bot propio, una plataforma que aun no tiene publicador—
 * sin tocar el codigo del motor.
 *
 * Manda una URL temporal en vez de los bytes. Un webhook es infraestructura del
 * propio estudio, no un tercero ajeno, y mandar cincuenta megas por POST a un
 * endpoint desconocido es una forma barata de agotar su servidor.
 */

const SIGNATURE_HEADER = 'X-MediaVault-Signature';
const MAX_URL_AGE_SECONDS = 900;

export const webhookPublisher: PlatformPublisher = {
  platform: 'webhook',
  implemented: true,
  mediaDelivery: 'url',
  // El destino descarga por su cuenta: aqui no hay limite propio que imponer.
  limits: { maxImageBytes: Number.MAX_SAFE_INTEGER, maxVideoBytes: Number.MAX_SAFE_INTEGER },

  async publish(request: PublishRequest): Promise<PublishOutcome> {
    const url = resolveUrl(request);
    if (url === null) {
      throw new PublishError(
        'La credencial de webhook no indica una URL https de destino.',
        'permanent',
      );
    }

    if (request.media.url === null) {
      throw new PublishError('El webhook necesita una URL temporal del medio.', 'permanent');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      event: 'publish',
      sentAt: new Date(timestamp * 1000).toISOString(),
      caption: request.caption,
      media: {
        url: request.media.url,
        type: request.media.type,
        mimeType: request.media.mimeType,
        sizeBytes: request.media.sizeBytes,
        // El destino debe saber que el enlace caduca: guardarlo para luego no
        // sirve de nada.
        expiresInSeconds: MAX_URL_AGE_SECONDS,
      },
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // La firma cubre el momento Y el cuerpo. Sin el momento dentro de lo
        // firmado, quien capture una peticion valida puede reenviarla cuando
        // quiera y el destino no sabria distinguirla de la original.
        [SIGNATURE_HEADER]: signPayload(request.secret, timestamp, payload),
        ...extraHeaders(request),
      },
      body: payload,
      cache: 'no-store',
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const verdict = classifyResponse({ status: response.status, headers: response.headers });
      throw new PublishError(
        `El webhook respondio ${response.status}: ${body.slice(0, 200)}`,
        verdict.kind,
        verdict.retryAfterSeconds,
      );
    }

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    return {
      externalId: typeof body?.id === 'string' ? body.id : null,
      url: typeof body?.url === 'string' ? body.url : null,
    };
  },
};

/**
 * Firma del cuerpo: `t=<epoch>,v1=<hmac hex>`.
 *
 * Mismo formato que usan Stripe y otros, y por la misma razon: el receptor
 * recalcula el HMAC sobre `<t>.<cuerpo>` y ademas rechaza lo que llegue con un
 * `t` viejo. El prefijo de version permite cambiar de algoritmo mas adelante sin
 * romper a quien ya escucha.
 */
export function signPayload(secret: string, timestamp: number, payload: string): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function resolveUrl(request: PublishRequest): string | null {
  const candidate =
    typeof request.settings.url === 'string' ? request.settings.url : request.accountIdentifier;

  if (candidate === null || candidate === undefined || candidate.trim() === '') return null;

  try {
    const parsed = new URL(candidate.trim());
    // Sin HTTPS, el texto y la URL del medio viajan en claro.
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Cabeceras extra que el estudio haya configurado (una clave de API propia, por ejemplo). */
function extraHeaders(request: PublishRequest): Record<string, string> {
  const configured = request.settings.headers;
  if (typeof configured !== 'object' || configured === null) return {};

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(configured as Record<string, unknown>)) {
    // Las cabeceras propias del protocolo no se dejan sobrescribir: permitirlo
    // dejaria al estudio anular la firma sin darse cuenta.
    if (['content-type', SIGNATURE_HEADER.toLowerCase()].includes(key.toLowerCase())) continue;
    if (typeof value === 'string') headers[key] = value;
  }
  return headers;
}
