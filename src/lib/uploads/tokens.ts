import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@/lib/env';

/**
 * Tokens de los enlaces de subida sin cuenta.
 *
 * El token viaja en la URL que recibe la modelo por WhatsApp o Telegram. En la
 * base solo se guarda su HMAC-SHA256, nunca el token en claro, y por dos razones
 * distintas:
 *
 *   - Si la base se filtra, los enlaces vivos no son utilizables: de un HMAC no
 *     se vuelve al token.
 *   - La clave del HMAC vive en el entorno, no en la base. Quien se lleve un
 *     volcado de PostgreSQL tampoco puede fabricar hashes validos.
 *
 * La busqueda es por igualdad exacta sobre el hash, que esta indexado. No hay
 * comparacion carater a caracter contra valores de la base, asi que no hay canal
 * lateral por tiempo en la consulta.
 */

/** 32 bytes de entropia en base64url: 43 caracteres sin nada que escapar en una URL. */
export function generateUploadToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashUploadToken(token) };
}

export function hashUploadToken(token: string): string {
  return createHmac('sha256', serverEnv().UPLOAD_LINK_SECRET).update(token).digest('hex');
}

/** Comparacion en tiempo constante, para los casos en que si se comparan hashes. */
export function tokenHashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function buildUploadUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/u/${token}`;
}
