/**
 * Que archivos de la nube merece la pena traer.
 *
 * Una carpeta compartida de años tiene de todo: contratos en PDF, hojas de
 * calculo, capturas de WhatsApp y archivos `.DS_Store`. Traerlos todos llenaria
 * el vault de ruido y gastaria egreso y almacenamiento en material que nadie va
 * a publicar.
 */

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'];

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
};

export function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export function isSupportedMedia(name: string): boolean {
  const extension = extensionOf(name);
  return IMAGE_EXTENSIONS.includes(extension) || VIDEO_EXTENSIONS.includes(extension);
}

export function mediaTypeOf(name: string): 'image' | 'video' | null {
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  return null;
}

export function mimeTypeOf(name: string): string {
  return MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * Archivos que los sistemas operativos y la propia nube dejan por ahi. Empiezan
 * por punto o son conocidos por nombre.
 */
export function isJunkFile(name: string): boolean {
  if (name.startsWith('.')) return true;
  return ['Thumbs.db', 'desktop.ini', 'Icon\r'].includes(name);
}
