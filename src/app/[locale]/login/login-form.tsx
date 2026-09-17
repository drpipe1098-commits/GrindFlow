'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/client';

/**
 * Entrada al panel. Delega toda la autenticacion en Supabase Auth: aqui no se
 * comprueba ninguna contrasena ni se decide ningun permiso.
 *
 * El mensaje de error es el mismo para credenciales malas y para usuario
 * inexistente, a proposito: distinguirlos convertiria este formulario en una
 * forma de averiguar que correos tienen cuenta en la plataforma.
 */
export function LoginForm() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError !== null) {
      setError(t('invalidCredentials'));
      setPending(false);
      return;
    }

    router.push('/');
    router.refresh();
  }

  const field =
    'w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-ink-50 placeholder:text-ink-600';

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('signIn')}</h1>

      <label className="flex flex-col gap-1.5 text-sm text-ink-400">
        {t('email')}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm text-ink-400">
        {t('password')}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          className={field}
        />
      </label>

      {error !== null && (
        <p role="alert" className="text-sm text-danger-500">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand-500 px-4 py-2.5 font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {t('signInCta')}
      </button>
    </form>
  );
}
