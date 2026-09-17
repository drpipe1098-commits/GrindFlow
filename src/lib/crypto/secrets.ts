import 'server-only';

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@/lib/env';

/**
 * Cifrado de secretos en reposo (tokens OAuth y API keys de las plataformas).
 *
 * AES-256-GCM. La eleccion importa: GCM es cifrado autenticado, asi que ademas
 * de ocultar el contenido detecta si alguien lo manipulo. Con AES-CBC un
 * atacante con acceso de escritura a la base puede alterar el texto cifrado y el
 * descifrado devuelve bytes distintos sin quejarse; con GCM, la etiqueta de
 * autenticacion no cuadra y la operacion falla.
 *
 * Formato almacenado:
 *
 *     v1.<iv>.<tag>.<ciphertext>          (cada parte en base64url)
 *
 * El prefijo de version no es decorativo: cuando haya que rotar la clave o
 * cambiar de algoritmo, se podra escribir `v2` y seguir descifrando lo viejo,
 * sin una migracion que toque todas las filas a la vez.
 *
 * Lo que esto protege y lo que no:
 *
 *   - Protege un volcado de la base. La clave vive en el entorno, no en
 *     PostgreSQL, asi que quien se lleve un backup no se lleva los tokens.
 *   - NO protege contra alguien que ya tenga acceso al servidor en ejecucion:
 *     ahi la clave esta en memoria. Para eso haria falta un KMS o un HSM, que
 *     es el paso siguiente si el producto crece.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, el tamano recomendado para GCM
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey !== null) return cachedKey;

  const raw = serverEnv().ENCRYPTION_MASTER_KEY;
  const key = Buffer.from(raw, 'hex');

  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `ENCRYPTION_MASTER_KEY debe ser de ${KEY_BYTES} bytes en hexadecimal ` +
        `(${KEY_BYTES * 2} caracteres). Genera una con: openssl rand -hex ${KEY_BYTES}`,
    );
  }

  cachedKey = key;
  return key;
}

/**
 * Cifra un secreto.
 *
 * `context` se firma junto al texto (datos autenticados adicionales) pero no se
 * guarda cifrado. Sirve para atar el criptograma a la fila que lo contiene: si
 * alguien copia el `secret_ciphertext` de una organizacion a otra, el contexto
 * ya no coincide y el descifrado falla. Sin esto, mover una celda entre filas
 * bastaria para robar un token.
 */
export function encryptSecret(plaintext: string, context?: string): string {
  if (plaintext.length === 0) {
    throw new SecretCryptoError('No se cifra una cadena vacia.');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv, {
    authTagLength: TAG_BYTES,
  });

  if (context !== undefined) {
    cipher.setAAD(Buffer.from(context, 'utf8'));
  }

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Descifra. Lanza `SecretCryptoError` si el dato fue alterado o el contexto no coincide. */
export function decryptSecret(payload: string, context?: string): string {
  const parts = payload.split('.');

  if (parts.length !== 4) {
    throw new SecretCryptoError('Formato de secreto cifrado invalido.');
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];

  if (version !== VERSION) {
    throw new SecretCryptoError(`Version de cifrado no soportada: ${version}`);
  }

  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretCryptoError('Secreto cifrado corrupto: IV o etiqueta con tamano incorrecto.');
  }

  const decipher = createDecipheriv(ALGORITHM, masterKey(), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tag);

  if (context !== undefined) {
    decipher.setAAD(Buffer.from(context, 'utf8'));
  }

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // El mensaje original de OpenSSL ("unable to authenticate data") no dice
    // nada util a quien lea el log, y detallar mas tampoco ayudaria a nadie
    // legitimo: si falla, el dato no es de fiar y punto.
    throw new SecretCryptoError(
      'No se pudo descifrar el secreto: fue alterado, la clave cambio o el contexto no corresponde.',
    );
  }
}

/** True si la cadena tiene la forma de un secreto cifrado por este modulo. */
export function isEncryptedSecret(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts[0] === VERSION;
}

/**
 * Comparacion en tiempo constante de dos secretos ya descifrados.
 *
 * Para verificar, por ejemplo, la firma de un webhook entrante: comparar con
 * `===` filtra por tiempo cuantos caracteres iniciales acerto quien lo intenta.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
