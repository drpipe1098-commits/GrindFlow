import { validateCaption, type PublishableCaption } from '@/lib/captions';
import { decryptSecret } from '@/lib/crypto/secrets';
import type { Platform } from '@/lib/database.types';
import { PublishError } from '@/lib/publishing/errors';
import { publisherFor } from '@/lib/publishing/registry';
import type { PublishMedia } from '@/lib/publishing/publisher';
import { getObjectBytes, presignDownload } from '@/lib/r2';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Trabajo `publish`: lleva una programacion vencida a su plataforma.
 *
 * El orden de las comprobaciones esta pensado para que lo barato descarte antes
 * que lo caro. Descargar cincuenta megas de R2 y despues descubrir que el
 * publicador no existe, que la cuenta esta suspendida o que el texto ya no pasa
 * el filtro es trabajo y dinero tirados.
 */

export interface PublishPayload {
  schedule_id: string;
}

export interface PublishJobOutcome {
  status: 'published' | 'skipped';
  externalId?: string | null;
  url?: string | null;
  reason?: string;
}

/** Vigencia de la URL temporal que se entrega a un webhook. */
const MEDIA_URL_TTL_SECONDS = 900;

export async function handlePublish(payload: PublishPayload): Promise<PublishJobOutcome> {
  const supabase = createServiceClient();

  const { data: schedule } = await supabase
    .from('schedules')
    .select('*')
    .eq('id', payload.schedule_id)
    .maybeSingle();

  if (schedule === null) {
    throw new PublishError(`La programacion ${payload.schedule_id} no existe.`, 'permanent');
  }

  // Alguien pudo cancelarla, o pudo publicarse ya, entre que se encolo y ahora.
  if (schedule.status !== 'queued') {
    return { status: 'skipped', reason: `la programacion estaba en estado ${schedule.status}` };
  }

  const publisher = publisherFor(schedule.platform);
  if (!publisher.implemented) {
    throw new PublishError(
      `No hay publicador para ${schedule.platform} todavia.`,
      'permanent',
    );
  }

  // Suspension por red: si el token de este perfil en esta plataforma fallo
  // antes, no se vuelve a intentar hasta que alguien lo arregle. Encadenar
  // peticiones con credenciales muertas es como se llega a un baneo.
  const { data: suspended } = await supabase.rpc('is_publishing_suspended', {
    p_profile: schedule.profile_id,
    p_platform: schedule.platform,
  });

  if (suspended === true) {
    throw new PublishError(
      `Los envios de este perfil a ${schedule.platform} estan suspendidos.`,
      'permanent',
    );
  }

  const { data: asset } = await supabase
    .from('media_assets')
    .select('r2_key, file_type, mime_type, bytes, derivatives, sanitized')
    .eq('id', schedule.asset_id)
    .maybeSingle();

  if (asset === null) {
    throw new PublishError('El asset de la programacion ya no existe.', 'permanent');
  }

  // La base ya lo impide al programar, pero se vuelve a mirar aqui: es la ultima
  // linea antes de que el archivo salga a internet, y publicar metadatos GPS es
  // el unico fallo de este sistema que no se deshace borrando el post.
  if (!asset.sanitized) {
    throw new PublishError(
      'El asset no esta sanitizado: aun conserva metadatos EXIF/GPS.',
      'permanent',
    );
  }

  const credential = await loadCredential(supabase, {
    organizationId: schedule.organization_id,
    profileId: schedule.profile_id,
    platform: schedule.platform,
  });

  const caption = await revalidateCaption(supabase, schedule.caption_text, {
    platform: schedule.platform,
    trackingLinkId: schedule.tracking_link_id,
  });

  const media = await prepareMedia({
    derivatives: asset.derivatives,
    fallbackKey: asset.r2_key,
    fileType: asset.file_type,
    mimeType: asset.mime_type,
    sizeBytes: asset.bytes,
    delivery: publisher.mediaDelivery,
    maxBytes:
      asset.file_type === 'image' ? publisher.limits.maxImageBytes : publisher.limits.maxVideoBytes,
  });

  // Pasar a 'publishing' hace saltar el trigger `schedules_enforce_gates`, que
  // vuelve a exigir expediente 2257 vigente. No es redundante: el expediente
  // pudo caducar entre que se programo y ahora.
  const { error: claimError } = await supabase
    .from('schedules')
    .update({ status: 'publishing', attempts: schedule.attempts + 1 })
    .eq('id', schedule.id)
    .eq('status', 'queued');

  if (claimError !== null) {
    throw new PublishError(
      `No se pudo pasar a publicando: ${claimError.message}`,
      'permanent',
    );
  }

  const outcome = await publisher.publish({
    caption,
    media,
    accountIdentifier: credential.accountIdentifier,
    settings: credential.settings,
    secret: credential.secret,
  });

  await supabase
    .from('schedules')
    .update({
      status: 'published',
      published: true,
      published_at: new Date().toISOString(),
      external_post_id: outcome.externalId,
      external_url: outcome.url,
      last_error: null,
    })
    .eq('id', schedule.id);

  await supabase
    .from('media_assets')
    .update({ status: 'published', last_published_at: new Date().toISOString() })
    .eq('id', schedule.asset_id);

  return { status: 'published', externalId: outcome.externalId, url: outcome.url };
}

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Credencial de la cuenta destino.
 *
 * Se prefiere la del perfil sobre la de la agencia: una modelo puede tener su
 * propio canal, y publicar en el canal general cuando ella tiene uno propio
 * seria mandar su contenido al sitio equivocado.
 */
async function loadCredential(
  supabase: ServiceClient,
  input: { organizationId: string; profileId: string; platform: Platform },
): Promise<{ secret: string; accountIdentifier: string | null; settings: Record<string, unknown> }> {
  const { data } = await supabase
    .from('platform_credentials')
    .select('*')
    .eq('organization_id', input.organizationId)
    .eq('platform', input.platform)
    .eq('active', true)
    .or(`profile_id.eq.${input.profileId},profile_id.is.null`)
    .order('profile_id', { nullsFirst: false })
    .limit(1);

  const credential = data?.[0];
  if (credential === undefined) {
    throw new PublishError(
      `No hay credencial activa de ${input.platform} para este perfil.`,
      'permanent',
    );
  }

  return {
    secret: decryptSecret(
      credential.secret_ciphertext,
      `mediavault:credential:${credential.organization_id}:${credential.platform}`,
    ),
    accountIdentifier: credential.account_identifier,
    settings: credential.settings,
  };
}

/**
 * Vuelve a pasar el texto por el filtro estricto, justo antes de enviarlo.
 *
 * `schedules.caption_text` es una cadena corriente en la base, y el publicador
 * exige `PublishableCaption`: la unica forma de obtener ese tipo es validar. No
 * es un tramite — entre que se programo y ahora pueden haber cambiado los
 * destinos verificados, o haberse editado el texto por otra via. Un texto que ya
 * no pasa el filtro no sale, y no se reintenta: fallara igual las cinco veces.
 */
async function revalidateCaption(
  supabase: ServiceClient,
  text: string,
  context: { platform: Platform; trackingLinkId: string | null },
): Promise<PublishableCaption> {
  const allowedHosts = new Set<string>();

  for (const candidate of [
    process.env.NEXT_PUBLIC_SHORT_LINK_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    if (candidate === undefined) continue;
    try {
      allowedHosts.add(new URL(candidate).hostname);
    } catch {
      // Una variable mal formada no debe impedir publicar por si sola.
    }
  }

  if (context.trackingLinkId !== null) {
    const { data: link } = await supabase
      .from('tracking_links')
      .select('destination_url')
      .eq('id', context.trackingLinkId)
      .maybeSingle();

    if (link !== null) {
      try {
        allowedHosts.add(new URL(link.destination_url).hostname);
      } catch {
        // Imposible en la practica: la columna exige https en una restriccion.
      }
    }
  }

  const result = validateCaption(text, {
    platform: context.platform,
    allowedHosts: [...allowedHosts],
  });

  if (!result.ok) {
    throw new PublishError(
      `El texto ya no pasa el filtro: ${result.issues.map((i) => i.message).join('; ')}`,
      'invalid_content',
    );
  }

  return result.caption;
}

/**
 * Prepara el medio segun lo que necesite el destino.
 *
 * Se publica el derivado con marca de agua, nunca el original: el original no
 * lleva marca y ademas es el archivo maestro del vault.
 */
async function prepareMedia(input: {
  derivatives: Record<string, string>;
  fallbackKey: string;
  fileType: 'image' | 'video';
  mimeType: string;
  sizeBytes: number;
  delivery: 'bytes' | 'url';
  maxBytes: number;
}): Promise<PublishMedia> {
  const key =
    input.derivatives.teaser ?? input.derivatives.web ?? input.derivatives.clean ?? input.fallbackKey;

  const media: PublishMedia = {
    type: input.fileType,
    bytes: null,
    url: null,
    mimeType: input.mimeType,
    fileName: key.split('/').pop() ?? 'archivo',
    sizeBytes: input.sizeBytes,
  };

  if (input.delivery === 'bytes') {
    media.bytes = await getObjectBytes(key, input.maxBytes);
    media.sizeBytes = media.bytes.byteLength;
    return media;
  }

  media.url = await presignDownload(key, MEDIA_URL_TTL_SECONDS);
  return media;
}
