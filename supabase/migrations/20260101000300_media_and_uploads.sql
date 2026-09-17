-- =============================================================================
-- 000300 — Vault de medios y enlaces de subida sin cuenta
-- =============================================================================

create table public.media_assets (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  profile_id        uuid not null,

  r2_key            text not null unique,
  file_type         public.media_type not null,
  mime_type         text not null,
  bytes             bigint not null check (bytes > 0),
  checksum_sha256   text check (checksum_sha256 ~ '^[a-f0-9]{64}$'),

  -- Lo pone en true el worker de Pillow/FFmpeg tras retirar EXIF y GPS. Mientras
  -- sea false el asset no puede llegar a la cola de publicacion.
  sanitized         bool not null default false,
  watermarked       bool not null default false,

  outfit_tag        text,
  session_date      date,
  status            public.asset_status not null default 'raw',

  -- Derivados web que produce el worker: mp4 H.264, webp, miniatura.
  derivatives       jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  last_published_at timestamptz,

  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete cascade,

  -- La organizacion desnormalizada acelera el RLS, y la FK compuesta de arriba
  -- impide que se desincronice del perfil.
  unique (id, organization_id),
  unique (id, profile_id)
);

create index media_assets_org_idx on public.media_assets (organization_id);
create index media_assets_profile_idx on public.media_assets (profile_id);
create index media_assets_status_idx on public.media_assets (organization_id, status);
-- El motor Hard Rule consulta por perfil y por prenda ordenando por reutilizacion.
create index media_assets_outfit_idx on public.media_assets (profile_id, outfit_tag)
  where outfit_tag is not null;

-- -----------------------------------------------------------------------------
-- Enlaces de subida: la superficie mas expuesta del sistema
-- -----------------------------------------------------------------------------
-- El token NUNCA se guarda en claro: solo su SHA-256. Si la base se filtra, los
-- enlaces vivos no son utilizables. El servidor valida el token, comprueba
-- vigencia, cuota y tipo MIME, y solo entonces emite una URL prefirmada de R2
-- de vida corta. En ningun momento se expone una credencial de escritura del
-- bucket.
create table public.upload_links (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  profile_id           uuid not null,

  token_hash           text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  label                text,

  expires_at           timestamptz not null,
  max_files            int not null default 50 check (max_files between 1 and 500),
  max_bytes_per_file   bigint not null default 2147483648 check (max_bytes_per_file > 0),
  allowed_mime         text[] not null default array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime'],

  uses_count           int not null default 0 check (uses_count >= 0),
  revoked_at           timestamptz,
  created_by           uuid references public.users (id) on delete set null,
  created_at           timestamptz not null default now(),

  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete cascade,

  constraint upload_link_expiry_is_future check (expires_at > created_at)
);

create index upload_links_profile_idx on public.upload_links (profile_id);
create index upload_links_org_idx on public.upload_links (organization_id);

-- Bitacora de cada subida hecha con un enlace: sin esto, una fuga de enlace es
-- invisible. Guarda IP y hora para poder auditar y revocar con criterio.
create table public.upload_link_events (
  id               uuid primary key default gen_random_uuid(),
  upload_link_id   uuid not null references public.upload_links (id) on delete cascade,
  r2_key           text not null,
  bytes            bigint,
  mime_type        text,
  ip               inet,
  occurred_at      timestamptz not null default now()
);

create index upload_link_events_link_idx on public.upload_link_events (upload_link_id, occurred_at desc);

-- Un enlace sirve si no esta revocado, no ha caducado y no agoto su cuota.
create or replace function app.upload_link_is_usable(p_link public.upload_links)
returns boolean
language sql
immutable
as $$
  select p_link.revoked_at is null
     and p_link.expires_at > now()
     and p_link.uses_count < p_link.max_files;
$$;

alter table public.media_assets       enable row level security;
alter table public.upload_links       enable row level security;
alter table public.upload_link_events enable row level security;
