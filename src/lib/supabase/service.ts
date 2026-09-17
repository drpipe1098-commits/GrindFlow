import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { publicEnv, serverEnv } from '@/lib/env';

/**
 * Cliente con la clave de servicio: OMITE EL RLS POR COMPLETO.
 *
 * Reservado para los tres casos donde no existe un usuario con sesion que pueda
 * autorizar la operacion:
 *
 *   1. El endpoint de subida anonima, que ya valido el token del enlace a mano.
 *   2. Los workers de Python y sus callbacks.
 *   3. Los runners de publicacion programada.
 *
 * `server-only` hace que el build falle si este modulo acaba importado desde un
 * componente de cliente. Es la barrera que impide que la clave viaje al navegador.
 */
export function createServiceClient() {
  const pub = publicEnv();
  const env = serverEnv();

  return createSupabaseClient<Database>(
    pub.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
