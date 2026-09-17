-- =============================================================================
-- Arranque para pruebas: reproduce lo que Supabase aporta de fabrica
-- =============================================================================
-- SOLO PARA PRUEBAS. No es una migracion y nunca corre en produccion: alli estas
-- piezas las provee Supabase. Existe para que las politicas RLS se puedan probar
-- contra un PostgreSQL normal, sin levantar la plataforma entera.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique,
  raw_user_meta_data  jsonb default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- Replica exacta de la funcion de Supabase: lee el `sub` del JWT que PostgREST
-- deja en la variable de sesion. Las pruebas la fijan para suplantar usuarios.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
