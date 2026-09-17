-- =============================================================================
-- 000800 — Funciones auxiliares de autorizacion
-- =============================================================================
-- Todas son SECURITY DEFINER a proposito. Dos razones:
--
--   1. Rompen la recursion. Una politica sobre `memberships` que consultara
--      `memberships` con RLS activo se llamaria a si misma sin fin. Al ser
--      SECURITY DEFINER, la funcion corre con los privilegios del dueno y no
--      vuelve a evaluar RLS.
--   2. Concentran la logica. Cambiar quien puede leer que se hace en un solo
--      lugar, no en treinta politicas repartidas.
--
-- Por eso llevan `search_path` fijo: sin el, un esquema temporal del atacante
-- podria suplantar las tablas que la funcion consulta.

-- Admin de plataforma: ve absolutamente todo. Es el unico rol que cruza
-- fronteras de organizacion.
create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin'
  );
$$;

-- Rol efectivo del usuario dentro de una organizacion. NULL si no es miembro.
create or replace function app.org_role(p_org uuid)
returns public.user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role
  from public.memberships m
  where m.organization_id = p_org and m.user_id = auth.uid();
$$;

create or replace function app.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.is_platform_admin() or app.org_role(p_org) is not null;
$$;

-- Gestion: dar de alta modelos, mover dinero, conectar cuentas.
create or replace function app.can_manage_org(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.is_platform_admin() or app.org_role(p_org) in ('admin', 'studio');
$$;

-- Ingesta: subir y preparar material. Incluye al editor.
create or replace function app.can_ingest_org(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.is_platform_admin() or app.org_role(p_org) in ('admin', 'studio', 'editor');
$$;

-- El usuario actual es la persona detras de este perfil.
create or replace function app.owns_profile(p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_profile and p.user_id = auth.uid()
  );
$$;

-- Lectura de contenido de un perfil: el equipo de la organizacion, o la modelo
-- sobre lo suyo. Una modelo NO ve el material de sus companeras de agencia.
create or replace function app.can_read_profile(p_profile uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.can_ingest_org(p_org) or (app.is_org_member(p_org) and app.owns_profile(p_profile));
$$;

-- Escritura de contenido de un perfil.
create or replace function app.can_write_profile(p_profile uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.can_ingest_org(p_org) or (app.is_org_member(p_org) and app.owns_profile(p_profile));
$$;

-- Expediente 2257: contiene documentos de identidad. El editor queda fuera —
-- necesita subir material, no ver cedulas.
create or replace function app.can_read_compliance(p_profile uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.can_manage_org(p_org) or (app.is_org_member(p_org) and app.owns_profile(p_profile));
$$;

-- Dinero: la agencia ve todo lo suyo, la modelo ve lo suyo, el editor nada.
create or replace function app.can_read_financials(p_profile uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.can_manage_org(p_org) or (app.is_org_member(p_org) and app.owns_profile(p_profile));
$$;

-- Comparte organizacion con el usuario dado y puede gestionarla. Decide quien
-- puede ver la ficha de otro usuario.
create or replace function app.shares_managed_org(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = auth.uid()
      and mine.role in ('admin', 'studio')
      and theirs.user_id = p_user
  );
$$;

-- Un usuario no puede ascenderse a si mismo. La politica de UPDATE deja que
-- edite su propia fila (nombre, email), pero `role` solo lo cambia un admin de
-- plataforma. RLS compara filas nuevas, no la transicion; esto si.
create or replace function app.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role and not app.is_platform_admin() then
    raise exception 'autorizacion: solo un admin de plataforma puede cambiar el rol de un usuario'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger users_prevent_role_escalation
  before update on public.users
  for each row execute function app.prevent_role_escalation();
