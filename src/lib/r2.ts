import 'server-only';

import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { serverEnv } from '@/lib/env';

/**
 * Acceso a Cloudflare R2 por su API compatible con S3.
 *
 * R2 no cobra egreso, que es lo que hace viable servir video pesado. La region
 * es siempre 'auto': R2 la ignora, pero el SDK de AWS exige un valor.
 */
let cachedClient: S3Client | null = null;

export function r2Client(): S3Client {
  if (cachedClient !== null) return cachedClient;

  const env = serverEnv();
  cachedClient = new S3Client({
    region: env.R2_REGION,
    endpoint: env.R2_ENDPOINT,
    // R2 y MinIO necesitan rutas del tipo endpoint/bucket/key.
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return cachedClient;
}

/**
 * Deja el nombre de archivo en algo seguro para una clave de objeto.
 *
 * Quita rutas, acentos y todo lo que no sea alfanumerico. Un nombre como
 * "../../otra-modelo/foto.jpg" no debe poder escribir fuera de su carpeta.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'archivo';
  const normalized = base.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const cleaned = normalized.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  return cleaned.slice(0, 120) || 'archivo';
}

/**
 * Clave de destino de una subida. El UUID delante evita colisiones entre dos
 * telefonos que suban "IMG_0001.jpg" el mismo dia, y el prefijo `inbox/` marca
 * que el archivo aun no esta sanitizado.
 */
export function buildInboxKey(profileFolder: string, filename: string): string {
  const folder = profileFolder.replace(/^\/+|\/+$/g, '');
  return `${folder}/inbox/${randomUUID()}-${sanitizeFilename(filename)}`;
}

export interface PresignUploadInput {
  key: string;
  contentType: string;
  /**
   * Tamano exacto del archivo. Se firma dentro de la URL: si el cliente envia
   * un byte de mas o de menos, R2 rechaza la peticion. Es lo que convierte el
   * limite de peso en una barrera real y no en una comprobacion que el cliente
   * puede saltarse.
   */
  contentLength: number;
  ttlSeconds?: number;
}

export async function presignUpload(input: PresignUploadInput): Promise<string> {
  const env = serverEnv();
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: input.key,
    ContentType: input.contentType,
    ContentLength: input.contentLength,
  });

  return getSignedUrl(r2Client(), command, {
    expiresIn: input.ttlSeconds ?? env.UPLOAD_PRESIGN_TTL_SECONDS,
  });
}

/**
 * Sube un flujo directamente al bucket, desde el servidor.
 *
 * Lo usa el worker de ingesta: un archivo traido de Dropbox nunca pasa por el
 * navegador, asi que no hay URL prefirmada de por medio.
 *
 * `contentLength` es obligatorio y no por capricho del SDK: sin el, el cliente
 * de S3 tendria que bufferizar el flujo entero para calcularlo, y con videos de
 * varios gigabytes eso tumba el contenedor.
 */
export async function uploadStream(input: {
  key: string;
  body: Readable;
  contentType: string;
  contentLength: number;
}): Promise<void> {
  const env = serverEnv();
  await r2Client().send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    }),
  );
}

/**
 * Descarga un objeto entero a memoria.
 *
 * Lo necesitan los destinos que suben por multipart, como Telegram. Lleva tope
 * obligatorio y no por prudencia general: sin el, un video de dos gigas tumba el
 * contenedor del worker y con el toda la cola de publicacion.
 */
export async function getObjectBytes(key: string, maxBytes: number): Promise<Uint8Array> {
  const env = serverEnv();
  const response = await r2Client().send(
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
  );

  const length = response.ContentLength ?? 0;
  if (length > maxBytes) {
    throw new Error(
      `El objeto ${key} pesa ${length} bytes y el tope para esta operacion es ${maxBytes}.`,
    );
  }

  const body = response.Body;
  if (body === undefined) {
    throw new Error(`El objeto ${key} no tiene contenido.`);
  }

  return new Uint8Array(await body.transformToByteArray());
}

/**
 * Borra un objeto.
 *
 * Lo necesita la ingesta cuando descubre, ya subido el archivo, que su contenido
 * duplica uno que ya estaba: se conserva la fila del inventario para poder
 * explicarlo, pero no una segunda copia de los mismos gigabytes.
 */
export async function deleteObject(key: string): Promise<void> {
  const env = serverEnv();
  await r2Client().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}

/**
 * URL de lectura temporal. La usan los paneles para mostrar material que no es
 * publico: originales sin marca de agua y, sobre todo, los documentos del
 * expediente 2257, que nunca deben quedar accesibles por URL permanente.
 */
export async function presignDownload(key: string, ttlSeconds = 120): Promise<string> {
  const env = serverEnv();
  const command = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
  return getSignedUrl(r2Client(), command, { expiresIn: ttlSeconds });
}
