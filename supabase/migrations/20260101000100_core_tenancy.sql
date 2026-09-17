-- =============================================================================
-- 000100 — Nucleo multi-tenant: organizaciones, usuarios, membresias y perfiles
-- =============================================================================

-- Toda fila del sistema cuelga de una organizacion. Es la unidad de aislamiento.
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  type        public.org_type not null default 'independent',
  created_at  timestamptz not null default now()
);

-- Espejo de auth.users con el rol de plataforma. Se llena por trigger.
create table public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  role        public.user_role not null default 'model',
  created_at  timestamptz not null default now()
);

-- Une un usuario a una organizacion con un rol. Un usuario puede pertenecer a
-- varias: una modelo que trabaja con dos agencias tiene dos membresias.
create table public.memberships (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  user_id          uuid not null references public.users (id) on delete cascade,
  role             public.user_role not null,
  created_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index memberships_user_idx on public.memberships (user_id);
create index memberships_org_idx on public.memberships (organization_id);

-- El perfil publico de una modelo. Deliberadamente NO comparte id con users:
-- una agencia registra a sus modelos y les da acceso despues (o nunca), asi que
-- `user_id` es opcional y se puede enlazar mas tarde sin migrar datos.
create table public.profiles (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  user_id               uuid references public.users (id) on delete set null,
  display_name          text not null check (length(btrim(display_name)) between 1 and 120),
  handle                text not null unique check (handle ~ '^[a-zA-Z0-9_.]{2,30}$'),
  rev_share_percentage  numeric(5,2) not null default 0
                          check (rev_share_percentage >= 0 and rev_share_percentage <= 100),
  r2_folder_path        text not null,
  created_at            timestamptz not null default now(),
  -- Permite que las tablas hijas lleven organization_id desnormalizado y que la
  -- base garantice que coincide con el de su perfil (ver FK compuesta mas abajo).
  unique (id, organization_id)
);

create index profiles_org_idx on public.profiles (organization_id);
create index profiles_user_idx on public.profiles (user_id) where user_id is not null;

-- Un usuario no puede tener dos perfiles dentro de la misma organizacion.
create unique index profiles_one_per_user_per_org
  on public.profiles (organization_id, user_id)
  where user_id is not null;

-- Alta automatica en public.users cuando Supabase Auth crea la cuenta.
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (id, email, role)
  values (
    new.id,
    new.email,
    coalesce((new.raw_user_meta_data ->> 'role')::public.user_role, 'model')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- Denegar por defecto: se habilita RLS aqui y las politicas llegan en 000900.
-- Entre ambas migraciones las tablas quedan cerradas, nunca abiertas.
alter table public.organizations enable row level security;
alter table public.users         enable row level security;
alter table public.memberships   enable row level security;
alter table public.profiles      enable row level security;
