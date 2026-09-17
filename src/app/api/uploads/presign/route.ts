import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { buildInboxKey, presignUpload } from '@/lib/r2';
import { createServiceClient } from '@/lib/supabase/service';
import { hashUploadToken } from '@/lib/uploads/tokens';

/**
 * Emision de URLs prefirmadas para las subidas sin cuenta (Modulo 2).
 *
 * Es el unico endpoint del sistema que atiende peticiones sin sesion, asi que
 * concentra las comprobaciones en vez de repartirlas:
 *
 *   1. El token del enlace se busca por su HMAC. El token en claro no esta en
 *      ninguna parte de la base.
 *   2. Se comprueba vigencia, revocacion y cuota antes de firmar nada.
 *   3. El tipo MIME tiene que estar en la lista blanca del enlace.
 *   4. El peso se valida aqui Y se firma dentro de la URL, de modo que R2
 *      rechaza por su cuenta cualquier cuerpo de tamano distinto.
 *   5. La cuota se consume ANTES de entregar la URL. Si la subida se abandona,
 *      se pierde un hueco; al reves —entregar primero y contar despues— un
 *      cliente en bucle sacaria URLs ilimitadas.
 *
 * Nunca se expone una credencial de escritura del bucket: lo unico que sale de
 * aqui es una URL para un objeto concreto, de un tamano concreto, que caduca en
 * minutos.
 */
export const runtime = 'nodejs';

const requestSchema = z.object({
  token: z.string().min(20).max(200),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(3).max(120),
  contentLength: z.number().int().positive(),
});

/** Respuesta deliberadamente vaga: un token invalido y uno caducado se ven igual. */
const rejection = (status: number, code: string) =>
  NextResponse.json({ error: code }, { status });

export async function POST(request: NextRequest) {
  const env = serverEnv();

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return rejection(400, 'peticion_invalida');
  }

  const { token, filename, contentType, contentLength } = parsed.data;

  // Tope global del despliegue: acota incluso un enlace mal configurado a mano.
  if (contentLength > env.UPLOAD_MAX_BYTES_PER_FILE) {
    return rejection(413, 'archivo_demasiado_grande');
  }

  const supabase = createServiceClient();

  const { data: link, error } = await supabase
    .from('upload_links')
    .select('*')
    .eq('token_hash', hashUploadToken(token))
    .maybeSingle();

  if (error !== null || link === null) {
    return rejection(404, 'enlace_no_valido');
  }

  if (link.revoked_at !== null) {
    return rejection(403, 'enlace_revocado');
  }

  if (new Date(link.expires_at).getTime() <= Date.now()) {
    return rejection(403, 'enlace_caducado');
  }

  if (link.uses_count >= link.max_files) {
    return rejection(429, 'cuota_agotada');
  }

  if (!link.allowed_mime.includes(contentType)) {
    return rejection(415, 'tipo_no_permitido');
  }

  if (contentLength > link.max_bytes_per_file) {
    return rejection(413, 'archivo_demasiado_grande');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('r2_folder_path')
    .eq('id', link.profile_id)
    .maybeSingle();

  if (profile === null) {
    return rejection(404, 'enlace_no_valido');
  }

  const key = buildInboxKey(profile.r2_folder_path, filename);

  // Consumo de cuota condicionado al valor leido: si dos peticiones simultaneas
  // usan el mismo enlace, solo una encuentra `uses_count` en el valor esperado y
  // la otra reintenta. Sin esta condicion, ambas pasarian y el enlace entregaria
  // una URL de mas.
  const { data: reserved } = await supabase
    .from('upload_links')
    .update({ uses_count: link.uses_count + 1 })
    .eq('id', link.id)
    .eq('uses_count', link.uses_count)
    .select('id')
    .maybeSingle();

  if (reserved === null) {
    return rejection(409, 'reintenta');
  }

  const uploadUrl = await presignUpload({
    key,
    contentType,
    contentLength,
    ttlSeconds: env.UPLOAD_PRESIGN_TTL_SECONDS,
  });

  // Bitacora: sin esto, una fuga de enlace seria invisible hasta que aparezca
  // material extrano en el vault.
  await supabase.from('upload_link_events').insert({
    upload_link_id: link.id,
    r2_key: key,
    bytes: contentLength,
    mime_type: contentType,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  } as never);

  return NextResponse.json({
    uploadUrl,
    key,
    expiresInSeconds: env.UPLOAD_PRESIGN_TTL_SECONDS,
    remainingUploads: link.max_files - link.uses_count - 1,
    // El cliente debe enviar exactamente estas cabeceras: van dentro de la firma.
    requiredHeaders: {
      'Content-Type': contentType,
      'Content-Length': String(contentLength),
    },
  });
}
