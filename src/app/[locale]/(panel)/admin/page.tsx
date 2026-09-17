import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Metric } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/server';
import { formatNumber } from '@/lib/utils';

/**
 * Panel de plataforma. Es el unico rol que cruza organizaciones, y lo hace
 * porque su politica RLS se lo permite explicitamente, no porque esta pagina
 * consulte de otra manera: las consultas son identicas a las del estudio.
 */
export default async function AdminDashboard({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('dashboard');
  const tm = await getTranslations('metrics');
  const supabase = await createClient();
  const count = { count: 'exact', head: true } as const;

  const [orgs, models, assets, scheduled, deadJobs] = await Promise.all([
    supabase.from('organizations').select('id', count),
    supabase.from('profiles').select('id', count),
    supabase.from('media_assets').select('id', count),
    supabase.from('schedules').select('id', count).eq('status', 'queued'),
    supabase.from('jobs').select('id', count).eq('status', 'dead'),
  ]);

  const n = (value: number | null) => formatNumber(value ?? 0, locale);

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('adminTitle')}</h1>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Metric label={tm('organizations')} value={n(orgs.count)} />
        <Metric label={tm('models')} value={n(models.count)} />
        <Metric label={tm('assets')} value={n(assets.count)} />
        <Metric label={tm('scheduled')} value={n(scheduled.count)} />
        <Metric
          label={tm('deadJobs')}
          value={n(deadJobs.count)}
          tone={(deadJobs.count ?? 0) > 0 ? 'danger' : 'ok'}
        />
      </div>
    </>
  );
}
