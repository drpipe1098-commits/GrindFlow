-- =============================================================================
-- 001100 — Conectores de ingesta desde nubes externas (Modulo 2)
-- =============================================================================
-- Escanea Google Drive y Dropbox en busca de material antiguo parado y lo trae
-- al vault. Es el "reciclador" del PRD: la mayoria de las agencias tienen anos
-- de sesiones en una carpeta compartida que nadie vuelve a abrir.
--
-- Esta migracion define SOLO el almacenamiento. El flujo OAuth y las llamadas a
-- cada API llegan en la entrega siguiente.

create type public.cloud_provider as enum ('google_drive', 'dropbox');

create type public.cloud_connection_status as enum (
  'active',
  -- El refresh token dejo de valer: la persona revoco el acceso o cambio la
  -- contrasena. Necesita volver a conectar, no se arregla reintentando.
  'expired',
  'revoked',
  'error'
);

create type public.cloud_item_status as enum (
  'discovered',
  'queued',
  'ingested',
  -- Descartado a proposito: duplicado, tipo no soportado o demasiado grande.
  'skipped',
  'failed'
);

-- -----------------------------------------------------------------------------
-- Cuentas de nube conectadas
-- -----------------------------------------------------------------------------
-- Los tokens van cifrados con el mismo AES-256-GCM que las credenciales de
-- publicacion (src/lib/crypto/secrets.ts). La base solo ve texto cifrado.
--
-- El refresh token es el activo delicado aqui: no caduca por si solo y da acceso
-- continuado a TODO el Drive de la persona, no solo a la carpeta que eligio.
-- Por eso esta tabla es la mas restringida del esquema: ni siquiera el editor,
-- que es quien mas trabaja con material, la puede leer.
create table public.cloud_connections (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,

  provider              public.cloud_provider not null,
  -- Cuenta remota, para que el panel muestre cual esta conectada.
  account_email         text,
  label                 text not null,

  access_ciphertext     text not null,
  -- Sin refresh token la conexion muere en una hora y el escaneo programado no
  -- sirve de nada: se exige al conectar (acceso sin conexion / offline).
  refresh_ciphertext    text not null,
  token_expires_at      timestamptz not null,
  scopes                text[] not null default '{}',

  status                public.cloud_connection_status not null default 'active',

  -- Carpeta raiz que la agencia autorizo a escanear. Fuera de ella no se mira,
  -- aunque el token de OAuth de acceso a mas.
  root_folder_id        text,
  root_folder_path      text,

  -- Perfil al que se asignan por defecto los archivos encontrados. Sin el, los
  -- archivos quedan en espera de asignacion manual.
  default_profile_id    uuid,

  -- Cursor de sincronizacion incremental: `pageToken` en Drive, `cursor` en
  -- Dropbox. Guardarlo evita releer el arbol entero en cada pasada, que en una
  -- cuenta con anos de material es la diferencia entre minutos y horas.
  delta_cursor          text,

  last_scan_at          timestamptz,
  last_error            text,
  created_by            uuid references public.users (id) on delete set null,
  created_at            timestamptz not null default now(),

  foreign key (default_profile_id, organization_id)
    references public.profiles (id, organization_id) on delete set null,

  -- Una misma cuenta remota no se conecta dos veces a la misma organizacion.
  unique (organization_id, provider, account_email)
);

create index cloud_connections_org_idx on public.cloud_connections (organization_id);
create index cloud_connections_refresh_idx
  on public.cloud_connections (token_expires_at)
  where status = 'active';

-- -----------------------------------------------------------------------------
-- Archivos vistos en la nube
-- -----------------------------------------------------------------------------
-- Una fila por archivo remoto. Su razon de ser es la deduplicacion: un escaneo
-- vuelve a ver los mismos archivos una y otra vez, y sin esta tabla cada pasada
-- volveria a descargar gigabytes y a crear assets duplicados en el vault.
create table public.cloud_ingest_items (
  id                    uuid primary key default gen_random_uuid(),
  connection_id         uuid not null references public.cloud_connections (id) on delete cascade,
  -- Desnormalizado para que el RLS filtre sin JOIN, igual que en el resto.
  organization_id       uuid not null references public.organizations (id) on delete cascade,

  remote_file_id        text not null,
  remote_path           text,
  remote_name           text not null,
  remote_mime_type      text,
  remote_size_bytes     bigint,
  remote_modified_at    timestamptz,
  -- Checksum que da el proveedor. Detecta el mismo archivo subido dos veces con
  -- nombres distintos, que en una carpeta compartida de anos es lo habitual.
  remote_checksum       text,

  status                public.cloud_item_status not null default 'discovered',
  skip_reason           text,
  last_error            text,

  -- Perfil destino y asset creado. Nulos hasta que se ingiere.
  profile_id            uuid,
  media_asset_id        uuid references public.media_assets (id) on delete set null,

  discovered_at         timestamptz not null default now(),
  ingested_at           timestamptz,

  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete set null,

  -- La clave de la deduplicacion: el mismo archivo remoto, una sola fila.
  unique (connection_id, remote_file_id)
);

create index cloud_items_connection_idx
  on public.cloud_ingest_items (connection_id, status);
create index cloud_items_org_idx on public.cloud_ingest_items (organization_id);
-- Para detectar el mismo contenido subido con otro nombre.
create index cloud_items_checksum_idx
  on public.cloud_ingest_items (organization_id, remote_checksum)
  where remote_checksum is not null;

-- -----------------------------------------------------------------------------
-- Trabajos nuevos de la cola
-- -----------------------------------------------------------------------------
-- Los valores se anaden aqui y se usan a partir de la entrega siguiente:
-- PostgreSQL no permite emplear un valor de enum en la misma transaccion en que
-- se crea.
alter type public.job_type add value if not exists 'scan_cloud_folder';
alter type public.job_type add value if not exists 'ingest_cloud_file';

alter table public.cloud_connections  enable row level security;
alter table public.cloud_ingest_items enable row level security;
