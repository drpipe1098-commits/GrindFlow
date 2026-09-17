import 'server-only';

import { PublishError, classifyResponse } from './errors';
import { mediaExceedsLimits, type PlatformPublisher, type PublishOutcome, type PublishRequest } from './publisher';

/**
 * Publicador de Telegram (Bot API).
 *
 * Se sube por `multipart/form-data` y no por URL. Telegram admite las dos
 * formas, pero la de URL exige que el archivo sea alcanzable publicamente, y el
 * material de este producto vive en un bucket privado: entregar una URL
 * prefirmada a un tercero para que la descargue deja ese enlace en sus registros.
 * Con multipart, los bytes salen de aqui y no queda ningun enlace vivo.
 *
 * Limites de subida de la Bot API: 10 MB para foto y 50 MB para video. Se
 * comprueban antes de enviar, porque superarlos gasta la subida entera para
 * recibir un 413 al final.
 */

const API_BASE = 'https://api.telegram.org';

export const telegramPublisher: PlatformPublisher = {
  platform: 'telegram',
  implemented: true,
  mediaDelivery: 'bytes',
  limits: { maxImageBytes: 10 * 1_048_576, maxVideoBytes: 50 * 1_048_576 },

  async publish(request: PublishRequest): Promise<PublishOutcome> {
    const chatId = resolveChatId(request);
    if (chatId === null) {
      throw new PublishError(
        'La credencial de Telegram no indica canal destino (chat_id o @handle).',
        'permanent',
      );
    }

    if (request.media.bytes === null) {
      throw new PublishError('Telegram necesita los bytes del archivo.', 'permanent');
    }

    const excess = mediaExceedsLimits(request.media, telegramPublisher.limits);
    if (excess !== null) {
      // 'invalid_content': reintentarlo cinco veces no lo hara mas pequeno.
      throw new PublishError(`Telegram: ${excess}`, 'invalid_content');
    }

    const isVideo = request.media.type === 'video';
    const method = isVideo ? 'sendVideo' : 'sendPhoto';

    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', request.caption);
    form.set(
      isVideo ? 'video' : 'photo',
      new Blob([request.media.bytes as BlobPart], { type: request.media.mimeType }),
      request.media.fileName,
    );

    // El material es sensible: la vista previa de enlaces de Telegram descarga
    // lo que encuentre en el texto y lo cachea en sus servidores.
    form.set('disable_web_page_preview', 'true');

    const response = await fetch(`${API_BASE}/bot${request.secret}/${method}`, {
      method: 'POST',
      body: form,
      cache: 'no-store',
    });

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    if (!response.ok || body?.ok !== true) {
      const verdict = classifyResponse({
        status: response.status,
        headers: response.headers,
        body,
      });
      throw new PublishError(
        `Telegram ${method} respondio ${response.status}: ${String(body?.description ?? '').slice(0, 200)}`,
        verdict.kind,
        verdict.retryAfterSeconds,
      );
    }

    return buildOutcome(body.result);
  },
};

/**
 * Canal destino.
 *
 * `account_identifier` guarda lo que el estudio configuro: un `@handle` publico
 * o un identificador numerico (los canales privados lo tienen, y negativo).
 * `settings.chat_id` tiene prioridad porque es lo que la Bot API acepta siempre.
 */
function resolveChatId(request: PublishRequest): string | null {
  const fromSettings = request.settings.chat_id;
  if (typeof fromSettings === 'string' && fromSettings.trim() !== '') return fromSettings.trim();
  if (typeof fromSettings === 'number') return String(fromSettings);

  const identifier = request.accountIdentifier?.trim() ?? '';
  return identifier === '' ? null : identifier;
}

function buildOutcome(result: unknown): PublishOutcome {
  if (typeof result !== 'object' || result === null) {
    return { externalId: null, url: null };
  }

  const message = result as Record<string, unknown>;
  const messageId = typeof message.message_id === 'number' ? String(message.message_id) : null;
  const chat = message.chat as Record<string, unknown> | undefined;
  const username = typeof chat?.username === 'string' ? chat.username : null;

  return {
    externalId: messageId,
    // Solo los canales publicos tienen enlace; los privados no, y devolver uno
    // inventado seria peor que no devolver ninguno.
    url: username !== null && messageId !== null ? `https://t.me/${username}/${messageId}` : null,
  };
}
