'use client';

import { useState, type ChangeEvent } from 'react';

/**
 * Subida directa del navegador a R2.
 *
 * El archivo NO pasa por el servidor de Next: se pide una URL prefirmada y el
 * PUT va directo al bucket. Un video de 2 GB cruzando una funcion serverless
 * seria lento, caro y chocaria con los limites de cuerpo de peticion.
 *
 * Las cabeceras del PUT tienen que coincidir exactamente con las que devuelve el
 * endpoint: van dentro de la firma, asi que R2 rechaza cualquier desviacion de
 * tipo o de tamano. El limite de peso no es una cortesia del cliente.
 */
type Status =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string };

const MESSAGES: Record<string, string> = {
  enlace_no_valido: 'Este enlace no es valido.',
  enlace_revocado: 'Este enlace fue revocado.',
  enlace_caducado: 'Este enlace ya caduco. Pide uno nuevo.',
  cuota_agotada: 'Este enlace ya alcanzo su limite de archivos.',
  tipo_no_permitido: 'Ese tipo de archivo no esta permitido.',
  archivo_demasiado_grande: 'El archivo supera el peso maximo permitido.',
  peticion_invalida: 'No se pudo procesar la solicitud.',
  reintenta: 'Hubo un conflicto. Intenta de nuevo.',
};

export function UploadClient({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function uploadOne(file: File): Promise<void> {
    setStatus({ kind: 'uploading', name: file.name });

    const presignResponse = await fetch('/api/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        filename: file.name,
        contentType: file.type,
        contentLength: file.size,
      }),
    });

    if (!presignResponse.ok) {
      const { error } = (await presignResponse.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(MESSAGES[error ?? ''] ?? 'No se pudo subir el archivo.');
    }

    const { uploadUrl, requiredHeaders } = (await presignResponse.json()) as {
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
    };

    // Content-Length lo fija el navegador a partir del cuerpo; enviarlo a mano
    // esta prohibido por la especificacion de fetch y provocaria un error.
    const { 'Content-Length': _length, ...headers } = requiredHeaders;

    const put = await fetch(uploadUrl, { method: 'PUT', headers, body: file });
    if (!put.ok) {
      throw new Error('El almacenamiento rechazo el archivo.');
    }
  }

  async function onSelect(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    try {
      // En serie, no en paralelo: subir seis videos a la vez desde datos moviles
      // suele acabar en seis fallos por tiempo de espera en lugar de uno a uno.
      for (const file of files) {
        await uploadOne(file);
      }
      setStatus({ kind: 'done', count: files.length });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Error inesperado.',
      });
    } finally {
      event.target.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="cursor-pointer rounded-xl border border-dashed border-ink-600 bg-ink-900 p-8 text-center transition hover:border-brand-400">
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
          onChange={onSelect}
          className="sr-only"
          disabled={status.kind === 'uploading'}
        />
        <span className="text-sm text-ink-200">Toca para elegir fotos o videos</span>
      </label>

      {status.kind === 'uploading' && (
        <p className="text-sm text-ink-400">Subiendo {status.name}...</p>
      )}
      {status.kind === 'done' && (
        <p className="text-sm text-ok-500">
          Listo: {status.count} archivo(s) subidos.
        </p>
      )}
      {status.kind === 'error' && (
        <p role="alert" className="text-sm text-danger-500">
          {status.message}
        </p>
      )}
    </div>
  );
}
