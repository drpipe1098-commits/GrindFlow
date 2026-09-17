'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/database.types';

/**
 * Cliente de navegador. Usa la clave anonima: todo lo que lea o escriba pasa por
 * las politicas RLS. Es correcto que esta clave sea publica — sin una sesion
 * valida no da acceso a ninguna fila.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  );
}
