import { setRequestLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { getAuthContext, landingPathFor } from '@/lib/auth';
import { LoginForm } from './login-form';

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const context = await getAuthContext();
  if (context !== null) {
    redirect({ href: landingPathFor(context.user.role), locale });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <LoginForm />
    </main>
  );
}
