-- =============================================================================
-- 001400 — Enrutado, deduplicacion por contenido y cola para los workers Node
-- =============================================================================

alter table public.cloud_ingest_items
  -- SHA-256 del contenido, calculado por el worker al descargar.
  --
  -- Distinto de `remote_checksum`, que es el hash propietario del proveedor
  -- (Dropbox usa un arbol de bloques propio, no SHA-256). El del proveedor sirve
  -- para detectar duplicados ANTES de descargar, que es lo barato; este otro los
  -- detecta con certeza DESPUES, y es el unico comparable entre proveedores:
  -- el mismo archivo subido a Drive y a Dropbox da distinto checksum remoto y el
  -- mismo SHA-256.
  add column content_sha256 text check (content_sha256 ~ '^[a-f0-9]{64}$'),

  -- Apunta al item que ya tenia este contenido. Es lo que permite al panel decir
  -- "ya lo tienes, subido el 3 de marzo" en vez de un escueto "duplicado".
  add column duplicate_of_item_id uuid references public.cloud_ingest_items (id) on delete set null,

  -- Como se decidio el perfil. Sirve para depurar el enrutado automatico y para
  -- que el panel distinga lo que decidio una persona de lo que dedujo el worker.
  add column assignment_source text
    check (assignment_source in ('default', 'folder_match', 'manual')),

  -- Nombre de la subcarpeta de primer nivel con la que se intento el match.
  -- Se guarda aunque falle: es lo que el estudio necesita ver para entender por
  -- que un archivo quedo sin asignar.
  add column matched_folder text;

create index cloud_items_content_hash_idx
  on public.cloud_ingest_items (organization_id, content_sha256)
  where content_sha256 is not null;

-- Cola de triaje: lo que espera a que alguien asigne un perfil.
create index cloud_items_unassigned_idx
  on public.cloud_ingest_items (organization_id, discovered_at desc)
  where status = 'unassigned';

comment on column public.cloud_ingest_items.status is
  'discovered -> (unassigned | queued) -> (ingested | duplicate | skipped | failed). '
  'Un item unassigned NO se descarga: sin perfil no hay carpeta de R2 donde '
  'ponerlo, y descargar gigabytes que nadie reclamo es trabajo tirado.';

-- -----------------------------------------------------------------------------
-- Acceso a la cola desde los workers de Node
-- -----------------------------------------------------------------------------
-- Los workers de Python hablan con PostgreSQL directamente y llaman a
-- `app.claim_jobs`. Los de Node van por PostgREST con la clave de servicio, y
-- PostgREST solo expone el esquema `public`.
--
-- Estos envoltorios son la unica via: delegan en las funciones de `app`, que
-- siguen siendo las que implementan SKIP LOCKED y el backoff. No duplican
-- ninguna logica, solo la publican. Y se conceden exclusivamente a
-- `service_role`: un cliente con la clave anonima no puede tomar trabajos.
create or replace function public.claim_jobs(
  p_worker text,
  p_batch  int default 1,
  p_types  public.job_type[] default null
)
returns setof public.jobs
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select * from app.claim_jobs(p_worker, p_batch, p_types);
$$;

create or replace function public.complete_job(
  p_job_id  uuid,
  p_success bool,
  p_error   text default null
)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select app.complete_job(p_job_id, p_success, p_error);
$$;

revoke all on function public.claim_jobs(text, int, public.job_type[]) from public;
revoke all on function public.complete_job(uuid, bool, text) from public;
grant execute on function public.claim_jobs(text, int, public.job_type[]) to service_role;
grant execute on function public.complete_job(uuid, bool, text) to service_role;
