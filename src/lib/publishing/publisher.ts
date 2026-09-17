import type { Platform } from '@/lib/database.types';
import type { PublishableCaption } from '@/lib/captions';

/**
 * Interfaz comun de los destinos de publicacion.
 *
 * El detalle que sostiene el modulo entero esta en el tipo de `caption`: es
 * `PublishableCaption`, que solo produce el validador del Modulo 4. Un `string`
 * corriente no compila aqui, asi que ningun publicador puede recibir un texto
 * que no haya pasado por el filtro estricto — ni el generado por el modelo, ni
 * el escrito a mano, ni uno construido sobre la marcha dentro del worker.
 *
 * No es una convencion que haya que recordar al escribir el siguiente
 * publicador: es el compilador quien lo impide.
 */

export interface PublishMedia {
  type: 'image' | 'video';
  /** Bytes en memoria. Los necesitan los destinos que suben por multipart. */
  bytes: Uint8Array | null;
  /** URL temporal firmada, para los destinos que descargan por su cuenta. */
  url: string | null;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}

export interface PublishRequest {
  /** Texto ya validado. El tipo es la garantia, no un comentario. */
  caption: PublishableCaption;
  media: PublishMedia;
  /** Cuenta destino: @canal de Telegram, subreddit, URL del webhook. */
  accountIdentifier: string | null;
  /** Ajustes propios del destino, guardados en la credencial. */
  settings: Record<string, unknown>;
  /** Secreto ya descifrado. Nunca se registra ni se serializa. */
  secret: string;
}

export interface PublishOutcome {
  /** Identificador del post en la plataforma, si lo devuelve. */
  externalId: string | null;
  /** Enlace publico al post, si se puede construir. */
  url: string | null;
}

export interface PlatformPublisher {
  readonly platform: Platform;
  /**
   * False mientras el destino este solo esbozado. El despachador lo consulta
   * antes de descargar el medio: bajar 50 MB de R2 para descubrir despues que el
   * destino no existe es trabajo y dinero tirados.
   */
  readonly implemented: boolean;
  /** Si necesita los bytes o le basta una URL temporal. */
  readonly mediaDelivery: 'bytes' | 'url';
  readonly limits: { maxImageBytes: number; maxVideoBytes: number };
  publish(request: PublishRequest): Promise<PublishOutcome>;
}

/**
 * Comprueba el peso contra los limites del destino ANTES de enviar.
 *
 * La alternativa es subir cincuenta megas para que la plataforma responda 413.
 * Devuelve el motivo, o `null` si cabe.
 */
export function mediaExceedsLimits(
  media: PublishMedia,
  limits: PlatformPublisher['limits'],
): string | null {
  const max = media.type === 'image' ? limits.maxImageBytes : limits.maxVideoBytes;
  if (media.sizeBytes <= max) return null;

  const mb = (value: number) => (value / 1_048_576).toFixed(1);
  return `el archivo pesa ${mb(media.sizeBytes)} MB y el limite del destino es ${mb(max)} MB`;
}
