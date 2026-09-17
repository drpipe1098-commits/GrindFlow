import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Card, CardTitle, Metric } from '@/components/ui/card';
import { getAuthContext } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { formatMoney, formatNumber } from '@/lib/utils';

/**
 * Panel de la modelo. Muestra lo que el Modulo 7 promete: trafico generado,
 * ingresos brutos, comision de la agencia y neto propio, con las mismas cifras
 * que ve el estudio. La transparencia es la razon de ser de esta pantalla.
 *
 * Tambien avisa cuando el expediente 2257 esta sin verificar o caducado, porque
 * en ese estado la base rechaza cualquier programacion y, sin este aviso, la
 * modelo veria su contenido parado sin entender por que.
 */
export default async function ModelDashboard({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('dashboard');
  const tm = await getTranslations('metrics');
  const tc = await getTranslations('compliance');

  const context = await getAuthContext();
  const supabase = await createClient();
  const count = { count: 'exact', head: true } as const;

  const [assets, scheduled, links, finance, compliance] = await Promise.all([
    supabase.from('media_assets').select('id', count),
    supabase.from('schedules').select('id', count).eq('status', 'queued'),
    supabase.from('tracking_links').select('clicks_count'),
    supabase
      .from('financial_records')
      .select('gross_amount, agency_fee, net_amount, currency')
      .order('period_start', { ascending: false })
      .limit(1),
    supabase.from('compliance_records').select('status, expires_at').limit(1),
  ]);

  const clicks = (links.data ?? []).reduce((sum, row) => sum + row.clicks_count, 0);
  const latest = finance.data?.[0] ?? null;
  const record = compliance.data?.[0] ?? null;
  const compliant =
    record?.status === 'verified' &&
    (record.expires_at === null || new Date(record.expires_at) > new Date());

  const n = (value: number | null) => formatNumber(value ?? 0, locale);
  const money = (value: number) => formatMoney(value, latest?.currency ?? 'USD', locale);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">{t('modelTitle')}</h1>
      <p className="mb-6 text-ink-400">
        {t('welcome', { name: context?.ownProfiles[0]?.display_name ?? '' })}
      </p>

      {!compliant && (
        <Card className="mb-6 border-warn-500/40 bg-warn-500/10">
          <p className="text-sm text-warn-500">{tc('blocked')}</p>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Metric label={tm('assets')} value={n(assets.count)} />
        <Metric label={tm('scheduled')} value={n(scheduled.count)} />
        <Metric label={tm('clicks')} value={n(clicks)} />
      </div>

      {latest !== null && (
        <Card className="mt-6">
          <CardTitle>{tm('netAmount')}</CardTitle>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-ink-400">{tm('grossAmount')}</p>
              <p className="text-xl font-semibold tabular-nums">
                {money(latest.gross_amount)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-400">{tm('agencyFee')}</p>
              <p className="text-xl font-semibold tabular-nums text-ink-400">
                {money(latest.agency_fee)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-400">{tm('netAmount')}</p>
              <p className="text-xl font-semibold tabular-nums text-ok-500">
                {money(latest.net_amount)}
              </p>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
