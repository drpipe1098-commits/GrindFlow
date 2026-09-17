import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Card, CardTitle } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/server';
import { TriageTable } from './triage-table';

/**
 * Panel de triaje: archivos descubiertos en la nube que no se pudieron asignar
 * a ninguna modelo.
 *
 * Ninguna consulta filtra por organizacion: el RLS ya lo hace. Y estos archivos
 * todavia NO estan descargados — sin perfil no hay carpeta de R2 donde ponerlos.
 * Asignarlos es lo que dispara la descarga.
 */
export default async function TriagePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('triage');
  const supabase = await createClient();

  const [{ data: items }, { data: profiles }] = await Promise.all([
    supabase
      .from('cloud_ingest_items')
      .select('id, remote_name, remote_path, remote_size_bytes, matched_folder, skip_reason, discovered_at')
      .eq('status', 'unassigned')
      .order('discovered_at', { ascending: false })
      .limit(500),
    supabase.from('profiles').select('id, display_name, handle').order('display_name'),
  ]);

  const pending = items ?? [];

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">{t('title')}</h1>
      <p className="mb-6 max-w-2xl text-sm text-ink-400">{t('intro')}</p>

      {pending.length === 0 ? (
        <Card>
          <CardTitle>{t('empty')}</CardTitle>
          <p className="text-sm text-ink-400">{t('emptyHint')}</p>
        </Card>
      ) : (
        <TriageTable items={pending} profiles={profiles ?? []} />
      )}
    </>
  );
}
