import { setRequestLocale } from 'next-intl/server';
import { UploadClient } from './upload-client';

/**
 * Pagina publica de subida (Modulo 2).
 *
 * No exige cuenta: la modelo abre el enlace en el movil y sube. El servidor no
 * valida el token aqui —lo hace el endpoint de firma en cada archivo— para que
 * esta pagina no sea un oraculo que diga si un token existe o no.
 */
export default async function UploadPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold">Subir material</h1>
        <p className="mt-1 text-sm text-ink-400">
          Los archivos se suben cifrados y se limpian de metadatos antes de
          publicarse.
        </p>
      </header>
      <UploadClient token={token} />
    </main>
  );
}
