import 'server-only';

import { createClient } from '@/lib/supabase/server';
import type { MembershipRow, ProfileRow, UserRole, UserRow } from '@/lib/database.types';

/**
 * Contexto de autorizacion de la peticion actual.
 *
 * Importante: esto NO es la barrera de seguridad. El aislamiento real lo hace el
 * RLS en PostgreSQL, que se aplica aunque alguien llame a la API saltandose la
 * interfaz. Lo de aqui decide que pantalla se muestra y que enlaces se pintan;
 * si fallara, el usuario veria un menu equivocado, no datos ajenos.
 */
export interface AuthContext {
  user: UserRow;
  memberships: MembershipRow[];
  /** Perfiles que la persona posee directamente (caso de una modelo). */
  ownProfiles: ProfileRow[];
}

export async function getAuthContext(): Promise<AuthContext | null> {
  const supabase = await createClient();

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (authUser === null) return null;

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle();

  if (user === null || user === undefined) return null;

  const [{ data: memberships }, { data: ownProfiles }] = await Promise.all([
    supabase.from('memberships').select('*'),
    supabase.from('profiles').select('*').eq('user_id', authUser.id),
  ]);

  return {
    user,
    memberships: memberships ?? [],
    ownProfiles: ownProfiles ?? [],
  };
}

/** Panel que corresponde al rol principal del usuario. */
export function landingPathFor(role: UserRole): string {
  switch (role) {
    case 'admin':
      return '/admin';
    case 'studio':
    case 'editor':
      return '/studio';
    case 'model':
      return '/model';
  }
}

export function hasOrgRole(
  context: AuthContext,
  organizationId: string,
  roles: readonly UserRole[],
): boolean {
  if (context.user.role === 'admin') return true;
  return context.memberships.some(
    (m) => m.organization_id === organizationId && roles.includes(m.role),
  );
}
