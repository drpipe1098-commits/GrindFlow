import 'server-only';

import type { CredentialType, Platform } from '@/lib/database.types';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Guardado y lectura de credenciales de plataforma.
 *
 * Es el unico camino por el que un token debe entrar o salir de
 * `platform_credentials`. Escribir en esa tabla directamente guardaria el
 * secreto en claro, y la base no puede impedirlo: solo ve texto.
 *
 * Usa la clave de servicio porque los runners de publicacion corren sin usuario
 * con sesion. El aislamiento entre organizaciones se mantiene por el contexto
 * criptografico (ver mas abajo), no por RLS.
 */

/**
 * Contexto que se firma junto al secreto (AAD de AES-GCM).
 *
 * Ata el criptograma a su organizacion y plataforma. Si alguien copia el
 * `secret_ciphertext` de la fila de una agencia a la de otra, el contexto ya no
 * coincide y el descifrado falla en vez de entregar el token. Sin esto, mover
 * una celda entre filas bastaria para robarlo.
 *
 * No incluye el id de la fila porque al cifrar todavia no existe: lo genera la
 * base al insertar.
 */
function credentialContext(organizationId: string, platform: Platform): string {
  return `mediavault:credential:${organizationId}:${platform}`;
}

/** Cifra un token opcional. Ausente o vacio se guarda como NULL, no como cifrado de "". */
function encryptOptional(value: string | null | undefined, context: string): string | null {
  const token = value ?? '';
  return token.length > 0 ? encryptSecret(token, context) : null;
}

export interface StoreCredentialInput {
  organizationId: string;
  /** Null cuando la cuenta es de la agencia; con valor cuando es de una modelo. */
  profileId?: string | null;
  platform: Platform;
  credentialType: CredentialType;
  label: string;
  accountIdentifier?: string | null;
  /** Token OAuth o API key, en claro. Se cifra antes de tocar la base. */
  secret: string;
  /** Solo OAuth: token de refresco. */
  refreshToken?: string | null;
  /** Solo OAuth: obligatorio, lo exige una restriccion de la tabla. */
  tokenExpiresAt?: string | null;
  scopes?: string[] | null;
  settings?: Record<string, unknown>;
}

export async function storePlatformCredential(
  input: StoreCredentialInput,
): Promise<{ id: string }> {
  if (input.credentialType === 'oauth' && !input.tokenExpiresAt) {
    // Se comprueba aqui ademas de en la base para fallar con un mensaje que
    // explique el porque, no con una violacion de restriccion.
    throw new Error(
      'Una credencial OAuth necesita fecha de caducidad: sin ella no hay forma ' +
        'de saber cuando refrescarla y la publicacion fallaria en silencio.',
    );
  }

  const context = credentialContext(input.organizationId, input.platform);
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('platform_credentials')
    .insert({
      organization_id: input.organizationId,
      profile_id: input.profileId ?? null,
      platform: input.platform,
      credential_type: input.credentialType,
      label: input.label,
      account_identifier: input.accountIdentifier ?? null,
      secret_ciphertext: encryptSecret(input.secret, context),
      refresh_ciphertext: encryptOptional(input.refreshToken, context),
      token_expires_at: input.tokenExpiresAt ?? null,
      scopes: input.scopes ?? null,
      settings: input.settings ?? {},
    })
    .select('id')
    .single();

  if (error !== null || data === null) {
    throw new Error(`No se pudo guardar la credencial: ${error?.message ?? 'sin datos'}`);
  }

  return { id: data.id };
}

export interface DecryptedCredential {
  id: string;
  platform: Platform;
  credentialType: CredentialType;
  accountIdentifier: string | null;
  secret: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  settings: Record<string, unknown>;
}

/**
 * Lee y descifra una credencial.
 *
 * Lo que devuelve son secretos en claro: no debe registrarse, ni serializarse a
 * una respuesta, ni cruzar hacia el cliente. Solo lo consumen los runners de
 * publicacion, en el momento de firmar la llamada a la plataforma.
 */
export async function getPlatformCredential(
  credentialId: string,
): Promise<DecryptedCredential | null> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('platform_credentials')
    .select('*')
    .eq('id', credentialId)
    .eq('active', true)
    .maybeSingle();

  if (error !== null || data === null) return null;

  const context = credentialContext(data.organization_id, data.platform);

  return {
    id: data.id,
    platform: data.platform,
    credentialType: data.credential_type,
    accountIdentifier: data.account_identifier,
    secret: decryptSecret(data.secret_ciphertext, context),
    refreshToken:
      data.refresh_ciphertext === null
        ? null
        : decryptSecret(data.refresh_ciphertext, context),
    tokenExpiresAt: data.token_expires_at,
    settings: data.settings,
  };
}

/**
 * Sustituye los tokens tras un refresco de OAuth.
 *
 * Se cifra con el mismo contexto: la organizacion y la plataforma no cambian al
 * refrescar, solo los tokens.
 */
export async function rotatePlatformTokens(
  credentialId: string,
  tokens: { secret: string; refreshToken?: string | null; tokenExpiresAt: string },
): Promise<void> {
  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('platform_credentials')
    .select('organization_id, platform')
    .eq('id', credentialId)
    .maybeSingle();

  if (existing === null) {
    throw new Error(`La credencial ${credentialId} no existe.`);
  }

  const context = credentialContext(existing.organization_id, existing.platform);

  const { error } = await supabase
    .from('platform_credentials')
    .update({
      secret_ciphertext: encryptSecret(tokens.secret, context),
      refresh_ciphertext: encryptOptional(tokens.refreshToken, context),
      token_expires_at: tokens.tokenExpiresAt,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', credentialId);

  if (error !== null) {
    throw new Error(`No se pudieron rotar los tokens: ${error.message}`);
  }
}
