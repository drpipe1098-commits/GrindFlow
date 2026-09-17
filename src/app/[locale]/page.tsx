import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { getAuthContext, landingPathFor } from '@/lib/auth';

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('home');
  const context = await getAuthContext();
  const target = context === null ? '/login' : landingPathFor(context.user.role);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <h1 className="text-4xl font-semibold tracking-tight">{t('heading')}</h1>
      <p className="text-ink-400">{t('body')}</p>
      <Link
        href={target}
        className="w-fit rounded-lg bg-brand-500 px-5 py-2.5 font-medium text-white transition hover:bg-brand-600"
      >
        {t('cta')}
      </Link>
    </main>
  );
}
