import { getTranslations, setRequestLocale } from 'next-intl/server';
import {
  Film,
  BarChart3,
  CalendarClock,
  Link2,
  Wallet,
  ShieldCheck,
  Users,
  Cpu,
  Inbox,
  Cloud,
} from 'lucide-react';
import { Link, redirect } from '@/i18n/routing';
import { getAuthContext } from '@/lib/auth';
import type { UserRole } from '@/lib/database.types';

/**
 * Chasis de los tres paneles. Comprueba que haya sesion y pinta la navegacion
 * que corresponde al rol.
 *
 * Ocultar un enlace no protege nada: quien escriba la ruta a mano llegara a la
 * pagina. Lo que impide que vea datos ajenos es el RLS, que se aplica en cada
 * consulta. Esto solo evita ensenar a una modelo un menu lleno de secciones que
 * no le corresponden.
 */
const NAV: Record<UserRole, { href: string; labelKey: string; Icon: typeof Film }[]> = {
  admin: [
    { href: '/admin', labelKey: 'dashboard', Icon: BarChart3 },
    { href: '/admin/organizations', labelKey: 'organizations', Icon: Users },
    { href: '/admin/jobs', labelKey: 'jobs', Icon: Cpu },
  ],
  studio: [
    { href: '/studio', labelKey: 'dashboard', Icon: BarChart3 },
    { href: '/studio/vault', labelKey: 'vault', Icon: Film },
    { href: '/studio/triage', labelKey: 'triage', Icon: Inbox },
    { href: '/studio/conectores', labelKey: 'connectors', Icon: Cloud },
    { href: '/studio/schedule', labelKey: 'schedule', Icon: CalendarClock },
    { href: '/studio/links', labelKey: 'links', Icon: Link2 },
    { href: '/studio/compliance', labelKey: 'compliance', Icon: ShieldCheck },
    { href: '/studio/finance', labelKey: 'finance', Icon: Wallet },
  ],
  editor: [
    { href: '/studio', labelKey: 'dashboard', Icon: BarChart3 },
    { href: '/studio/vault', labelKey: 'vault', Icon: Film },
    // El triaje es trabajo de ingesta: el editor decide que material entra.
    { href: '/studio/triage', labelKey: 'triage', Icon: Inbox },
    { href: '/studio/schedule', labelKey: 'schedule', Icon: CalendarClock },
  ],
  model: [
    { href: '/model', labelKey: 'dashboard', Icon: BarChart3 },
    { href: '/model/vault', labelKey: 'vault', Icon: Film },
    { href: '/model/links', labelKey: 'links', Icon: Link2 },
    { href: '/model/finance', labelKey: 'finance', Icon: Wallet },
  ],
};

export default async function PanelLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const context = await getAuthContext();
  if (context === null) {
    redirect({ href: '/login', locale });
  }

  const t = await getTranslations('nav');
  const tRoles = await getTranslations('roles');
  const role = context!.user.role;

  return (
    <div className="flex min-h-screen">
      <nav className="flex w-60 shrink-0 flex-col gap-1 border-r border-ink-800 bg-ink-900 p-4">
        <p className="px-3 pb-4 text-lg font-semibold tracking-tight">MediaVault</p>

        {NAV[role].map(({ href, labelKey, Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-200 transition hover:bg-ink-800"
          >
            <Icon size={16} aria-hidden />
            {t(labelKey)}
          </Link>
        ))}

        <div className="mt-auto border-t border-ink-800 px-3 pt-4">
          <p className="truncate text-sm text-ink-200">{context!.user.email}</p>
          <p className="text-xs text-ink-400">{tRoles(role)}</p>
        </div>
      </nav>

      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
