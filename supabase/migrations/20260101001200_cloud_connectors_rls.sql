-- =============================================================================
-- 001200 — Politicas RLS de los conectores de nube
-- =============================================================================
-- Va en un archivo aparte de la migracion que crea las tablas porque estas
-- politicas no pueden escribirse en la misma transaccion que anadio valores al
-- enum `job_type`.

-- Los privilegios de tabla y el RLS son dos capas distintas, y la de fuera hay
-- que concederla explicitamente: el `grant ... on all tables` de la migracion
-- 000900 solo alcanzo a las tablas que existian entonces. Una tabla nueva nace
-- sin privilegios para `authenticated`, asi que PostgreSQL corta antes incluso
-- de evaluar las politicas — con un "permission denied" que no menciona el RLS
-- por ningun lado.
grant select, insert, update, delete on public.cloud_connections to authenticated;
grant select, insert, update, delete on public.cloud_ingest_items to authenticated;

-- Para que la proxima tabla no repita el mismo tropiezo: a partir de aqui, todo
-- lo que cree este rol en `public` nace con los privilegios concedidos. El RLS
-- sigue siendo quien decide las filas; esto solo abre la puerta de fuera.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- --- cloud_connections -------------------------------------------------------
-- La tabla mas restringida del esquema. Guarda refresh tokens que dan acceso
-- continuado al Drive completo de una persona, no solo a la carpeta elegida.
-- El editor queda fuera igual que en `platform_credentials`, y por lo mismo:
-- necesita material, no llaves.
create policy cloud_connections_select on public.cloud_connections
  for select to authenticated
  using (app.can_manage_org(organization_id));

create policy cloud_connections_insert on public.cloud_connections
  for insert to authenticated
  with check (app.can_manage_org(organization_id));

create policy cloud_connections_update on public.cloud_connections
  for update to authenticated
  using (app.can_manage_org(organization_id))
  with check (app.can_manage_org(organization_id));

-- Desconectar debe poder hacerlo la agencia sin pasar por soporte: ante una
-- sospecha, cerrar rapido importa mas que la jerarquia.
create policy cloud_connections_delete on public.cloud_connections
  for delete to authenticated
  using (app.can_manage_org(organization_id));

-- --- cloud_ingest_items ------------------------------------------------------
-- El inventario de archivos vistos no contiene secretos, solo nombres y rutas,
-- asi que el editor si lo ve: es quien decide que se ingiere y que se descarta.
create policy cloud_items_select on public.cloud_ingest_items
  for select to authenticated
  using (app.can_ingest_org(organization_id));

-- Marcar un archivo como descartado es parte del trabajo de curacion.
create policy cloud_items_update on public.cloud_ingest_items
  for update to authenticated
  using (app.can_ingest_org(organization_id))
  with check (app.can_ingest_org(organization_id));

-- Sin politica de INSERT ni DELETE: las filas las crea el worker de escaneo con
-- la clave de servicio. Un cliente que pudiera insertarlas podria inventar
-- archivos remotos que nadie vio.
