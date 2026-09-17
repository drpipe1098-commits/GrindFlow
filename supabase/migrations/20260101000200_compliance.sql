-- =============================================================================
-- 000200 — Expediente de cumplimiento (18 U.S.C. 2257)
-- =============================================================================
-- Requisito legal para distribuir este material: por cada persona que aparece en
-- un asset debe existir prueba de mayoria de edad verificada y una liberacion
-- firmada, bajo un custodio de registros identificable.
--
-- Este modulo no es decorativo: `app.profile_is_compliant()` alimenta un trigger
-- que impide programar contenido de un perfil sin expediente vigente. El bloqueo
-- vive en la base, no en la interfaz, para que ningun script, worker ni llamada
-- directa a la API lo pueda rodear.

create table public.compliance_records (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  profile_id             uuid not null,
  status                 public.compliance_status not null default 'pending',

  -- Claves de R2, nunca los documentos en si. Viven en un bucket privado y
  -- separado del contenido publicable, y jamas se sirven por URL publica.
  id_document_r2_key     text,
  model_release_r2_key   text,

  -- Fecha de nacimiento verificada contra el documento.
  date_of_birth          date,
  verified_at            timestamptz,
  -- Caducidad del expediente. Al vencer, `profile_is_compliant` devuelve false
  -- y las publicaciones nuevas quedan bloqueadas automaticamente.
  expires_at             timestamptz,
  verified_by            uuid references public.users (id) on delete set null,

  -- Custodio de registros exigido por la norma.
  custodian_name         text,
  custodian_address      text,

  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Garantiza que el perfil pertenece a la organizacion declarada.
  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete cascade,

  -- Un expediente verificado necesita respaldo completo: sin documento, sin
  -- liberacion, sin fecha de nacimiento o sin custodio no se puede marcar.
  constraint compliance_verified_requires_evidence check (
    status <> 'verified' or (
      id_document_r2_key is not null
      and model_release_r2_key is not null
      and date_of_birth is not null
      and verified_at is not null
      and custodian_name is not null
    )
  ),

  -- La persona debia ser mayor de edad al momento de la verificacion.
  constraint compliance_adult_at_verification check (
    date_of_birth is null
    or verified_at is null
    or verified_at::date >= (date_of_birth + interval '18 years')::date
  )
);

create index compliance_profile_idx on public.compliance_records (profile_id);
create index compliance_org_idx on public.compliance_records (organization_id);

-- Un unico expediente verificado por perfil: evita que un registro caducado y
-- uno vigente convivan y que la consulta de vigencia sea ambigua.
create unique index compliance_one_verified_per_profile
  on public.compliance_records (profile_id)
  where status = 'verified';

-- Un perfil esta habilitado si tiene expediente verificado y sin vencer.
create or replace function app.profile_is_compliant(p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.compliance_records cr
    where cr.profile_id = p_profile
      and cr.status = 'verified'
      and (cr.expires_at is null or cr.expires_at > now())
  );
$$;

alter table public.compliance_records enable row level security;
