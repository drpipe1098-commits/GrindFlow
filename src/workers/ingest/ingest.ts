import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { cloudClientFor } from '@/lib/connectors/clients';
import { loadActiveConnection } from '@/lib/connectors/connection';
import { buildInboxKey, deleteObject, uploadStream } from '@/lib/r2';
import { createServiceClient } from '@/lib/supabase/service';
import { mediaTypeOf, mimeTypeOf } from './media-types';

/**
 * Trabajo `ingest_cloud_file`: trae un archivo concreto al vault.
 *
 * Nace en el vault exactamente igual que una subida desde el movil:
 * `sanitized = false` y un trabajo de sanitizacion encolado detras. Que venga de
 * Dropbox no le da ningun privilegio — un archivo de una carpeta compartida
 * conserva los mismos metadatos EXIF con coordenadas que uno subido a mano, y la
 * base rechaza programarlo hasta que el worker de medios los retire.
 */

export interface IngestPayload {
  item_id: string;
}

export interface IngestOutcome {
  status: 'ingested' | 'duplicate' | 'skipped';
  assetId?: string;
  duplicateOf?: string;
  reason?: string;
}

const MAX_BYTES = Number(process.env.INGEST_MAX_BYTES_PER_FILE ?? '5368709120');

export async function handleIngest(payload: IngestPayload): Promise<IngestOutcome> {
  const supabase = createServiceClient();

  const { data: item } = await supabase
    .from('cloud_ingest_items')
    .select('*')
    .eq('id', payload.item_id)
    .maybeSingle();

  if (item === null) {
    throw new Error(`El item de ingesta ${payload.item_id} no existe.`);
  }

  // Puede haber cambiado entre que se encolo y se ejecuta: alguien lo descarto
  // en el triaje, o una pasada posterior lo marco duplicado.
  if (item.status !== 'queued') {
    return { status: 'skipped', reason: `el item ya estaba en estado ${item.status}` };
  }

  if (item.profile_id === null) {
    await failItem(supabase, item.id, 'encolado sin perfil asignado');
    return { status: 'skipped', reason: 'sin perfil asignado' };
  }

  const size = item.remote_size_bytes ?? 0;
  if (size <= 0 || size > MAX_BYTES) {
    await supabase
      .from('cloud_ingest_items')
      .update({ status: 'skipped', skip_reason: `peso fuera de rango (${size} bytes)` })
      .eq('id', item.id);
    return { status: 'skipped', reason: 'peso fuera de rango' };
  }

  const connection = await loadActiveConnection(item.connection_id);
  if (connection === null) {
    throw new Error(`La conexion ${item.connection_id} no esta activa.`);
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('r2_folder_path, handle')
    .eq('id', item.profile_id)
    .maybeSingle();

  if (profile === null) {
    await failItem(supabase, item.id, 'el perfil destino ya no existe');
    return { status: 'skipped', reason: 'perfil inexistente' };
  }

  const fileType = mediaTypeOf(item.remote_name);
  if (fileType === null) {
    await supabase
      .from('cloud_ingest_items')
      .update({ status: 'skipped', skip_reason: 'tipo de archivo no soportado' })
      .eq('id', item.id);
    return { status: 'skipped', reason: 'tipo no soportado' };
  }

  const key = buildInboxKey(profile.r2_folder_path, item.remote_name);
  const mimeType = mimeTypeOf(item.remote_name);

  // --- Descarga y subida en un solo paso -------------------------------------
  // El archivo va de Dropbox a R2 sin tocar el disco ni caber entero en memoria.
  // El SHA-256 se calcula al vuelo, sobre los mismos bytes que pasan: leerlo
  // despues obligaria a descargar dos veces.
  const hasher = createHash('sha256');
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hasher.update(chunk);
      callback(null, chunk);
    },
  });

  const webStream = await cloudClientFor(connection.row.provider).download({
    accessToken: connection.accessToken,
    fileId: item.remote_file_id,
  });

  await uploadStream({
    key,
    body: Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]).pipe(tap),
    contentType: mimeType,
    contentLength: size,
  });

  const contentSha256 = hasher.digest('hex');

  // --- Deduplicacion por contenido -------------------------------------------
  // La comprobacion certera, ya con los bytes en la mano. Detecta el mismo
  // archivo subido dos veces con nombres distintos, que en una carpeta
  // compartida de anos es lo habitual.
  const { data: twins } = await supabase
    .from('cloud_ingest_items')
    .select('id')
    .eq('organization_id', item.organization_id)
    .eq('content_sha256', contentSha256)
    .eq('status', 'ingested')
    .neq('id', item.id)
    .limit(1);

  const twin = twins?.[0]?.id;

  if (twin !== undefined) {
    // No se descarta en silencio: la fila queda con el estado y el enlace al
    // original, para que el panel pueda decir "ya lo tienes, subido el 3 de
    // marzo". Lo que si se borra es la segunda copia de los bytes.
    await deleteObject(key);
    await supabase
      .from('cloud_ingest_items')
      .update({
        status: 'duplicate',
        content_sha256: contentSha256,
        duplicate_of_item_id: twin,
        skip_reason: 'mismo contenido que un archivo ya ingerido',
      })
      .eq('id', item.id);

    return { status: 'duplicate', duplicateOf: twin };
  }

  // --- Alta en el vault ------------------------------------------------------
  const { data: asset, error: assetError } = await supabase
    .from('media_assets')
    .insert({
      organization_id: item.organization_id,
      profile_id: item.profile_id,
      r2_key: key,
      file_type: fileType,
      mime_type: mimeType,
      bytes: size,
      checksum_sha256: contentSha256,
      // Lo levanta el worker de medios tras retirar EXIF y GPS. Hasta entonces,
      // la base rechaza cualquier intento de programarlo.
      sanitized: false,
      status: 'raw',
      session_date: item.remote_modified_at?.slice(0, 10) ?? null,
    })
    .select('id')
    .single();

  if (assetError !== null || asset === null) {
    await deleteObject(key);
    throw new Error(`No se pudo crear el asset: ${assetError?.message ?? 'sin datos'}`);
  }

  await supabase
    .from('cloud_ingest_items')
    .update({
      status: 'ingested',
      media_asset_id: asset.id,
      content_sha256: contentSha256,
      ingested_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', item.id);

  await supabase.from('jobs').insert({
    organization_id: item.organization_id,
    job_type: 'sanitize_exif',
    payload: {
      asset_id: asset.id,
      r2_key: key,
      file_type: fileType,
      handle: profile.handle,
    },
  });

  return { status: 'ingested', assetId: asset.id };
}

async function failItem(
  supabase: ReturnType<typeof createServiceClient>,
  itemId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from('cloud_ingest_items')
    .update({ status: 'failed', last_error: reason })
    .eq('id', itemId);
}
