import 'server-only';

import type { CloudConnectionRow, CloudProvider } from '@/lib/database.types';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets';
import { connectorEnv } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/service';
import { DropboxError, refreshAccessToken as refreshDropbox } from './dropbox';
import { GoogleDriveError, refreshAccessToken as refreshDrive } from './google-drive';

/**
 * Ciclo de vida de una conexion de nube: guardar, cargar y refrescar.
 *
 * Es el unico camino por el que un token de nube entra o sale de la base, igual
 * que `credentials.ts` lo es para los tokens de publicacion. Escribir en
 * `cloud_connections` directamente guardaria el refresh token en claro.
 */

/** Credenciales de la aplicacion de Google, comprobadas al usarse. */
function driveCredentials(): { clientId: string; clientSecret: string } {
  const env = connectorEnv();
  if (env.GOOGLE_CLIENT_ID === undefined || env.GOOGLE_CLIENT_SECRET === undefined) {
    throw new Error(
      'Google Drive no esta configurado: faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET.',
    );
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

/**
 * Contexto criptografico. Ata el token a su organizacion y proveedor: copiar el
 * `refresh_ciphertext` de una agencia a la fila de otra deja de funcionar,
 * porque el contexto ya no coincide y el descifrado falla.
 */
function cloudContext(organizationId: string, provider: CloudProvider): string {
  return `mediavault:cloud:${organizationId}:${provider}`;
}

export interface StoreConnectionInput {
  organizationId: string;
  provider: CloudProvider;
  label: string;
  accountEmail: string | null;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
  rootFolderPath: string | null;
  /** Drive identifica carpetas por id opaco; Dropbox, por ruta. */
  rootFolderId?: string | null;
  createdBy: string | null;
}

export async function storeCloudConnection(
  input: StoreConnectionInput,
): Promise<{ id: string }> {
  const context = cloudContext(input.organizationId, input.provider);
  const supabase = createServiceClient();

  const row = {
    organization_id: input.organizationId,
    provider: input.provider,
    account_email: input.accountEmail,
    label: input.label,
    access_ciphertext: encryptSecret(input.accessToken, context),
    refresh_ciphertext: encryptSecret(input.refreshToken, context),
    token_expires_at: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    scopes: input.scopes,
    status: 'active' as const,
    root_folder_path: input.rootFolderPath,
    root_folder_id: input.rootFolderId ?? null,
    last_error: null,
    created_by: input.createdBy,
  };

  // Reconectar la misma cuenta debe actualizar la conexion existente, no crear
  // una segunda: `unique (organization_id, provider, account_email)` lo impide,
  // y sin `upsert` la reconexion tras una revocacion fallaria con un error de
  // clave duplicada que no explica nada.
  const { data, error } = await supabase
    .from('cloud_connections')
    .upsert(row, { onConflict: 'organization_id,provider,account_email' })
    .select('id')
    .single();

  if (error !== null || data === null) {
    throw new Error(`No se pudo guardar la conexion: ${error?.message ?? 'sin datos'}`);
  }

  return { id: data.id };
}

export interface ActiveConnection {
  row: CloudConnectionRow;
  accessToken: string;
}

/** Margen de refresco: se renueva antes de caducar, no cuando ya caduco. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Carga una conexion lista para usar, refrescando el token si hace falta.
 *
 * Devuelve `null` cuando la conexion no existe o ya no es utilizable. Un
 * `invalid_grant` de Dropbox significa que la persona revoco el acceso o cambio
 * la contrasena: la conexion pasa a `expired` y hace falta reconectar. Insistir
 * no lo arregla, y repetido acaba con la aplicacion limitada por el proveedor.
 */
export async function loadActiveConnection(
  connectionId: string,
): Promise<ActiveConnection | null> {
  const supabase = createServiceClient();

  const { data: row } = await supabase
    .from('cloud_connections')
    .select('*')
    .eq('id', connectionId)
    .maybeSingle();

  if (row === null || row.status !== 'active') return null;

  const context = cloudContext(row.organization_id, row.provider);
  const expiresAt = new Date(row.token_expires_at).getTime();

  if (expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return { row, accessToken: decryptSecret(row.access_ciphertext, context) };
  }

  const env = connectorEnv();
  const refreshToken = decryptSecret(row.refresh_ciphertext, context);

  try {
    const refreshed =
      row.provider === 'dropbox'
        ? await refreshDropbox({
            refreshToken,
            appKey: env.DROPBOX_APP_KEY,
            appSecret: env.DROPBOX_APP_SECRET,
          })
        : await refreshDrive({ refreshToken, ...driveCredentials() });

    const newExpiry = new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString();

    await supabase
      .from('cloud_connections')
      .update({
        access_ciphertext: encryptSecret(refreshed.accessToken, context),
        token_expires_at: newExpiry,
        last_error: null,
      })
      .eq('id', connectionId);

    return {
      row: { ...row, token_expires_at: newExpiry },
      accessToken: refreshed.accessToken,
    };
  } catch (error) {
    // Ambos proveedores distinguen "hay que reconectar" de "fallo pasajero": en
    // los dos, `invalid_grant` significa revocacion y reintentar no lo arregla.
    const needsReconnect =
      (error instanceof DropboxError || error instanceof GoogleDriveError) &&
      error.needsReconnect;
    await markConnection(
      connectionId,
      needsReconnect ? 'expired' : 'error',
      error instanceof Error ? error.message : 'error desconocido al refrescar',
    );
    return null;
  }
}

export async function markConnection(
  connectionId: string,
  status: CloudConnectionRow['status'],
  lastError: string | null,
): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from('cloud_connections')
    .update({ status, last_error: lastError })
    .eq('id', connectionId);
}
