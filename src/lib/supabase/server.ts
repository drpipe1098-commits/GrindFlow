import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { Database } from '@/lib/database.types';
import { publicEnv } from '@/lib/env';

/**
 * Cliente de servidor ligado a la sesion del usuario. Sigue usando la clave
 * anonima, asi que el RLS se aplica igual que en el navegador: renderizar en el
 * servidor no es una via para saltarse el aislamiento.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const env = publicEnv();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Un Server Component no puede escribir cookies. El refresco de la
            // sesion ya lo hace el middleware, asi que aqui se ignora.
          }
        },
      },
    },
  );
}
