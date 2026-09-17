-- =============================================================================
-- 001500 — Cadencia de escaneo y soporte de Google Drive
-- =============================================================================

alter table public.cloud_connections
  -- Cada cuanto se escanea esta conexion. Por conexion y no global: un estudio
  -- que sube a diario quiere media hora y un archivo historico que no cambia
  -- desde 2023 no necesita que lo miren 48 veces al dia.
  add column scan_interval_minutes int not null default 30
    check (scan_interval_minutes between 5 and 10080),

  -- Permite pausar la ingesta sin desconectar la cuenta ni perder el cursor.
  add column scan_enabled bool not null default true,

  -- Carpeta raiz en Drive. Dropbox usa rutas y Drive identificadores opacos, asi
  -- que `root_folder_id` ya existia; esto solo documenta que ahora se usa.
  add column drive_start_page_token text;

comment on column public.cloud_connections.delta_cursor is
  'Cursor de sincronizacion incremental. En Dropbox es el `cursor` de '
  'list_folder; en Drive, el pageToken de changes.list. Guardarlo evita releer '
  'el arbol entero en cada pasada.';

-- -----------------------------------------------------------------------------
-- Un solo escaneo vivo por conexion
-- -----------------------------------------------------------------------------
-- El programador corre dentro del worker, y puede haber varias replicas del
-- worker. Sin esta restriccion, cuatro replicas que despiertan a la vez encolan
-- cuatro escaneos de la misma conexion, y los cuatro recorren la misma cuenta.
--
-- Se impone en la base y no en el codigo del programador a proposito: es la
-- unica capa que ven todas las replicas a la vez.
create unique index jobs_one_live_scan_per_connection
  on public.jobs ((payload ->> 'connection_id'))
  where job_type = 'scan_cloud_folder' and status in ('pending', 'claimed');

-- Conexiones que toca escanear. La usa el programador del worker.
create index cloud_connections_due_idx
  on public.cloud_connections (last_scan_at nulls first)
  where status = 'active' and scan_enabled;
