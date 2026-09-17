import 'server-only';

import type { CloudProvider } from '@/lib/database.types';
import { DropboxError, dropboxClient } from './dropbox';
import { GoogleDriveError, googleDriveClient } from './google-drive';
import type { CloudClient } from './provider';

/**
 * Factoria de clientes de nube.
 *
 * Es el unico punto del worker que sabe que proveedores existen. `scan.ts` e
 * `ingest.ts` solo ven la interfaz.
 */
const CLIENTS: Record<CloudProvider, CloudClient> = {
  dropbox: dropboxClient,
  google_drive: googleDriveClient,
};

export function cloudClientFor(provider: CloudProvider): CloudClient {
  return CLIENTS[provider];
}

/**
 * True cuando el fallo significa "hay que volver a conectar" y no "reintenta".
 *
 * Los dos proveedores lo senalan igual —`invalid_grant`— y en ambos reintentar
 * no lo arregla nunca: la persona revoco el acceso o cambio la contrasena.
 * Insistir en bucle es ademas como se acaba limitado por el proveedor.
 */
export function needsReconnect(error: unknown): boolean {
  return (
    (error instanceof DropboxError || error instanceof GoogleDriveError) && error.needsReconnect
  );
}
