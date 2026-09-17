import { cloudClientFor, needsReconnect } from '@/lib/connectors/clients';
import { loadActiveConnection, markConnection } from '@/lib/connectors/connection';
import {
  routeToProfile,
  type AssignmentSource,
  type RoutableProfile,
} from '@/lib/connectors/routing';
import type { RemoteFile } from '@/lib/connectors/provider';
import { createServiceClient } from '@/lib/supabase/service';
import { isJunkFile, isSupportedMedia, mimeTypeOf } from './media-types';

/**
 * Trabajo `scan_cloud_folder`: descubre que hay en la nube y lo registra.
 *
 * No descarga nada. Recorrer es barato y descargar no, asi que el escaneo solo
 * anota, decide a quien pertenece cada archivo y encola la descarga de los que
 * ya tienen destino.
 *
 * Un archivo sin perfil asignado NO se descarga: sin perfil no hay carpeta de R2
 * donde ponerlo, y traer gigabytes que nadie ha reclamado es trabajo tirado.
 * Queda en `unassigned` esperando el triaje del estudio.
 */

const MAX_PAGES_PER_RUN = 50;

export interface ScanPayload {
  connection_id: string;
}

export interface ScanOutcome {
  discovered: number;
  queued: number;
  unassigned: number;
  duplicates: number;
  skipped: number;
}

export async function handleScan(payload: ScanPayload): Promise<ScanOutcome> {
  const connection = await loadActiveConnection(payload.connection_id);
  if (connection === null) {
    // `loadActiveConnection` ya marco el motivo en la fila. Lanzar aqui deja el
    // trabajo en la cola de fallos, que es donde el panel lo muestra.
    throw new Error(
      `La conexion ${payload.connection_id} no esta activa. Hace falta reconectarla.`,
    );
  }

  const supabase = createServiceClient();
  const { row, accessToken } = connection;

  const { data: profileRows } = await supabase
    .from('profiles')
    .select('id, handle, display_name')
    .eq('organization_id', row.organization_id);

  const profiles: RoutableProfile[] = (profileRows ?? []).map((profile) => ({
    id: profile.id,
    handle: profile.handle,
    displayName: profile.display_name,
  }));

  const outcome: ScanOutcome = {
    discovered: 0,
    queued: 0,
    unassigned: 0,
    duplicates: 0,
    skipped: 0,
  };

  // El cliente del proveedor esconde las diferencias entre nubes: Dropbox tiene
  // rutas y listado recursivo; Drive, identificadores opacos y un arbol que hay
  // que recorrer. Aqui abajo ya da igual cual sea.
  const client = cloudClientFor(row.provider);
  const listContext = {
    accessToken,
    rootPath: row.root_folder_path,
    rootId: row.root_folder_id,
  };

  let cursor = row.delta_cursor;
  let pages = 0;

  try {
    while (pages < MAX_PAGES_PER_RUN) {
      const listing =
        cursor === null
          ? await client.listInitial(listContext)
          : await client.listIncremental({ ...listContext, cursor });

      pages += 1;
      cursor = listing.cursor;

      for (const file of listing.files) {
        outcome.discovered += 1;

        if (isJunkFile(file.name) || !isSupportedMedia(file.name)) {
          outcome.skipped += 1;
          await upsertItem(supabase, {
            connectionId: row.id,
            organizationId: row.organization_id,
            file,
            status: 'skipped',
            skipReason: 'tipo de archivo no soportado',
          });
          continue;
        }

        // Duplicado detectado ANTES de descargar, con el hash del proveedor. Es
        // la comprobacion barata; la certera se hace luego con el SHA-256 del
        // contenido ya descargado.
        const twin = await findTwinByRemoteChecksum(
          supabase,
          row.organization_id,
          file.checksum,
          file.id,
        );

        if (twin !== null) {
          outcome.duplicates += 1;
          await upsertItem(supabase, {
            connectionId: row.id,
            organizationId: row.organization_id,
            file,
            status: 'duplicate',
            duplicateOfItemId: twin,
            skipReason: 'mismo contenido que un archivo ya registrado',
          });
          continue;
        }

        const decision = routeToProfile({
          remotePath: file.path,
          rootPath: row.root_folder_path,
          defaultProfileId: row.default_profile_id,
          profiles,
        });

        const itemId = await upsertItem(supabase, {
          connectionId: row.id,
          organizationId: row.organization_id,
          file,
          status: decision.profileId === null ? 'unassigned' : 'queued',
          profileId: decision.profileId,
          assignmentSource: decision.source,
          matchedFolder: decision.matchedFolder,
          skipReason: decision.reason ?? null,
        });

        if (decision.profileId === null) {
          outcome.unassigned += 1;
          continue;
        }

        outcome.queued += 1;
        if (itemId !== null) {
          await supabase.from('jobs').insert({
            organization_id: row.organization_id,
            job_type: 'ingest_cloud_file',
            payload: { item_id: itemId },
          });
        }
      }

      if (!listing.hasMore) break;
    }

    // El cursor se guarda al final y solo si todo fue bien: guardarlo a medias
    // haria que la proxima pasada se saltara lo que quedo sin procesar.
    await supabase
      .from('cloud_connections')
      .update({ delta_cursor: cursor, last_scan_at: new Date().toISOString(), last_error: null })
      .eq('id', row.id);

    return outcome;
  } catch (error) {
    if (needsReconnect(error)) {
      await markConnection(
        row.id,
        'expired',
        error instanceof Error ? error.message : 'acceso revocado',
      );
    }
    throw error;
  }
}

type ServiceClient = ReturnType<typeof createServiceClient>;

async function findTwinByRemoteChecksum(
  supabase: ServiceClient,
  organizationId: string,
  checksum: string | null,
  ownRemoteId: string,
): Promise<string | null> {
  if (checksum === null) return null;

  const { data } = await supabase
    .from('cloud_ingest_items')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('remote_checksum', checksum)
    .neq('remote_file_id', ownRemoteId)
    .in('status', ['queued', 'ingested'])
    .limit(1);

  return data?.[0]?.id ?? null;
}

async function upsertItem(
  supabase: ServiceClient,
  input: {
    connectionId: string;
    organizationId: string;
    file: RemoteFile;
    status: 'queued' | 'unassigned' | 'duplicate' | 'skipped';
    profileId?: string | null;
    assignmentSource?: AssignmentSource | null;
    matchedFolder?: string | null;
    duplicateOfItemId?: string | null;
    skipReason?: string | null;
  },
): Promise<string | null> {
  const { data } = await supabase
    .from('cloud_ingest_items')
    .upsert(
      {
        connection_id: input.connectionId,
        organization_id: input.organizationId,
        remote_file_id: input.file.id,
        remote_name: input.file.name,
        remote_path: input.file.path,
        remote_mime_type: mimeTypeOf(input.file.name),
        remote_size_bytes: input.file.sizeBytes,
        remote_modified_at: input.file.modifiedAt,
        remote_checksum: input.file.checksum,
        status: input.status,
        profile_id: input.profileId ?? null,
        assignment_source: input.assignmentSource ?? null,
        matched_folder: input.matchedFolder ?? null,
        duplicate_of_item_id: input.duplicateOfItemId ?? null,
        skip_reason: input.skipReason ?? null,
      },
      { onConflict: 'connection_id,remote_file_id' },
    )
    .select('id')
    .maybeSingle();

  return data?.id ?? null;
}
