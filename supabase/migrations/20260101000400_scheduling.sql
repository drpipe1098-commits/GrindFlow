-- =============================================================================
-- 000400 — Motor de programacion y sus reglas duras
-- =============================================================================

-- Configuracion del anti-repeticion por organizacion. La matematica de elegir
-- el siguiente asset vive en TypeScript (src/lib/scheduling/hard-rule.ts) y esta
-- cubierta por pruebas; aqui viven los parametros y las barreras que la base
-- impone pase lo que pase.
create table public.scheduling_rules (
  organization_id          uuid primary key references public.organizations (id) on delete cascade,
  -- Dias que debe esperar un asset antes de poder reutilizarse.
  asset_cooldown_days      int not null default 30 check (asset_cooldown_days between 0 and 3650),
  -- Dias que debe esperar una prenda/sesion antes de repetirse.
  outfit_cooldown_days     int not null default 7 check (outfit_cooldown_days between 0 and 3650),
  -- Separacion minima entre dos publicaciones del mismo perfil en una plataforma.
  min_gap_minutes          int not null default 120 check (min_gap_minutes between 0 and 20160),
  -- Tope diario por perfil y plataforma.
  max_posts_per_day        int not null default 6 check (max_posts_per_day between 1 and 100),
  updated_at               timestamptz not null default now()
);

create table public.schedules (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  profile_id        uuid not null,
  asset_id          uuid not null,

  platform          public.platform not null,
  scheduled_at      timestamptz not null,
  status            public.schedule_status not null default 'queued',
  published         bool not null default false,
  published_at      timestamptz,

  caption_text      text not null check (length(caption_text) <= 4000),
  -- Copia de la prenda al momento de programar: si el asset se reetiqueta
  -- despues, el historial del anti-repeticion no se falsea retroactivamente.
  outfit_tag        text,
  tracking_link_id  uuid,

  attempts          int not null default 0,
  last_error        text,
  created_by        uuid references public.users (id) on delete set null,
  created_at        timestamptz not null default now(),

  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete cascade,
  foreign key (asset_id, profile_id)
    references public.media_assets (id, profile_id) on delete cascade,

  -- `published` y `status` no pueden contradecirse.
  constraint schedule_published_consistency check (
    (published and status = 'published' and published_at is not null)
    or (not published and status <> 'published')
  )
);

create index schedules_org_idx on public.schedules (organization_id);
create index schedules_due_idx on public.schedules (scheduled_at) where status = 'queued';
create index schedules_profile_history_idx
  on public.schedules (profile_id, platform, scheduled_at desc);

-- Barrera dura: un mismo asset no puede tener dos publicaciones vivas en la
-- misma plataforma. Aunque falle la logica de aplicacion, la base lo rechaza.
create unique index schedules_no_duplicate_live
  on public.schedules (asset_id, platform)
  where status in ('queued', 'publishing');

-- -----------------------------------------------------------------------------
-- Compuertas que la base impone antes de aceptar una programacion
-- -----------------------------------------------------------------------------
create or replace function app.enforce_schedule_gates()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sanitized bool;
begin
  -- 1. Cumplimiento 2257 vigente. Sin expediente verificado no se programa nada.
  if not app.profile_is_compliant(new.profile_id) then
    raise exception
      'cumplimiento: el perfil % no tiene expediente 2257 verificado y vigente', new.profile_id
      using errcode = 'check_violation';
  end if;

  -- 2. Anti-doxxing. Un asset sin sanitizar conserva EXIF/GPS: publicarlo puede
  -- revelar el domicilio de la modelo. Es la barrera mas importante del sistema.
  select sanitized into v_sanitized from public.media_assets where id = new.asset_id;
  if v_sanitized is distinct from true then
    raise exception
      'sanitizacion: el asset % aun conserva metadatos EXIF/GPS', new.asset_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger schedules_enforce_gates
  before insert or update of asset_id, profile_id, status on public.schedules
  for each row
  when (new.status in ('queued', 'publishing', 'published'))
  execute function app.enforce_schedule_gates();

-- Toda organizacion nueva arranca con reglas por defecto.
create or replace function app.seed_scheduling_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.scheduling_rules (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

create trigger organizations_seed_rules
  after insert on public.organizations
  for each row execute function app.seed_scheduling_rules();

alter table public.scheduling_rules enable row level security;
alter table public.schedules        enable row level security;
