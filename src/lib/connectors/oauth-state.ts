import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { connectorEnv } from '@/lib/env';

/**
 * Parametro `state` de OAuth2, firmado.
 *
 * Sin esto, la integracion tiene un agujero concreto y conocido: un tercero
 * inicia el flujo con SU cuenta de Dropbox, obtiene un codigo y consigue que
 * alguien de la agencia visite la URL de retorno. La conexion se crea dentro de
 * la organizacion de la victima pero apunta a la nube del atacante, que a partir
 * de ahi ve todo lo que se ingiera.
 *
 * El `state` firmado lo cierra: lleva dentro la organizacion, el usuario y un
 * nonce, y la firma es HMAC-SHA256 con un secreto del servidor. Nadie de fuera
 * puede fabricar uno valido, y la ruta de retorno ademas comprueba que el
 * usuario con sesion sea el mismo que inicio el flujo.
 *
 * Caduca a los diez minutos. Un flujo de OAuth que tarda mas es un flujo
 * abandonado, y un `state` eterno es un `state` reutilizable.
 */

const MAX_AGE_SECONDS = 600;

export interface OAuthStatePayload {
  organizationId: string;
  userId: string;
  provider: 'dropbox' | 'google_drive';
  nonce: string;
  issuedAt: number;
}

function sign(payload: string): string {
  return createHmac('sha256', connectorEnv().OAUTH_STATE_SECRET).update(payload).digest('base64url');
}

export function createOAuthState(
  input: Omit<OAuthStatePayload, 'nonce' | 'issuedAt'>,
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url');
  const payload: OAuthStatePayload = {
    ...input,
    nonce,
    issuedAt: Math.floor(Date.now() / 1000),
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { state: `${encoded}.${sign(encoded)}`, nonce };
}

/** Devuelve el contenido si la firma es valida y no caduco; `null` en cualquier otro caso. */
export function verifyOAuthState(state: string): OAuthStatePayload | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts as [string, string];
  const expected = sign(encoded);

  // Comparacion en tiempo constante: con `===` se puede averiguar la firma
  // correcta caracter a caracter midiendo cuanto tarda en responder.
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    return null;
  }

  if (typeof payload.issuedAt !== 'number') return null;
  if (Math.floor(Date.now() / 1000) - payload.issuedAt > MAX_AGE_SECONDS) return null;

  return payload;
}
