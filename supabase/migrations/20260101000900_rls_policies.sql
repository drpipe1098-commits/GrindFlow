-- =============================================================================
-- 000900 — Politicas RLS
-- =============================================================================
-- Criterio: se conceden permisos por accion (select/insert/update/delete) y
-- nunca con `for all`, para que una politica de lectura no abra escritura por
-- descuido. Toda tabla sin politica de INSERT es de solo lectura para el cliente:
-- esas escrituras pasan por el servidor con la clave de servicio.

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- `anon` no toca ninguna tabla: su unica via son los dos RPC del redirector.

-- --- organizations -----------------------------------------------------------
create policy organizations_select on public.organizations
  for select to authenticated
  using (app.is_org_member(id));

create policy organizations_update on public.organizations
  for update to authenticated
  using (app.can_manage_org(id))
  with check (app.can_manage_org(id));

-- Crear y borrar organizaciones es de admin de plataforma; el alta de una modelo
-- independiente pasa por el servidor, que valida el registro antes de crearla.
create policy organizations_admin_insert on public.organizations
  for insert to authenticated
  with check (app.is_platform_admin());

create policy organizations_admin_delete on public.organizations
  for delete to authenticated
  using (app.is_platform_admin());

-- --- users -------------------------------------------------------------------
create policy users_select on public.users
  for select to authenticated
  using (id = auth.uid() or app.is_platform_admin() or app.shares_managed_org(id));

-- El cambio de `role` lo bloquea el trigger users_prevent_role_escalation.
create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid() or app.is_platform_admin())
  with check (id = auth.uid() or app.is_platform_admin());

-- Sin politica de INSERT: las altas las hace el trigger de auth.users.

-- --- memberships -------------------------------------------------------------
create policy memberships_select on public.memberships
  for select to authenticated
  using (user_id = auth.uid() or app.can_manage_org(organization_id));

create policy memberships_insert on public.memberships
  for insert to authenticated
  with check (app.can_manage_org(organization_id));

create policy memberships_update on public.memberships
  for update to authenticated
  using (app.can_manage_org(organization_id))
  with check (app.can_manage_org(organization_id));

create policy memberships_delete on public.memberships
  for delete to authenticated
  using (app.can_manage_org(organization_id));

-- --- profiles ----------------------------------------------------------------
create policy profiles_select on public.profiles
  for select to authenticated
  using (app.can_read_profile(id, organization_id));

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (app.can_manage_org(organization_id));

-- La modelo edita su ficha; el reparto de ingresos no (lo impide el trigger de
-- mas abajo, porque `rev_share_percentage` es una condicion economica pactada).
create policy profiles_update on public.profiles
  for update to authenticated
  using (app.can_manage_org(organization_id) or app.owns_profile(id))
  with check (app.can_manage_org(organization_id) or app.owns_profile(id));

create policy profiles_delete on public.profiles
  for delete to authenticated
  using (app.can_manage_org(organization_id));

create or replace function app.protect_rev_share()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.rev_share_percentage is distinct from old.rev_share_percentage
     and not app.can_manage_org(old.organization_id) then
    raise exception 'autorizacion: el porcentaje de reparto solo lo cambia la agencia'
      using errcode = 'insufficient_privilege';
  end if;
  -- Mover un perfil de organizacion vaciaria el aislamiento de sus datos.
  if new.organization_id is distinct from old.organization_id and not app.is_platform_admin() then
    raise exception 'autorizacion: un perfil no puede cambiar de organizacion'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger profiles_protect_rev_share
  before update on public.profiles
  for each row execute function app.protect_rev_share();

-- --- compliance_records ------------------------------------------------------
create policy compliance_select on public.compliance_records
  for select to authenticated
  using (app.can_read_compliance(profile_id, organization_id));

-- Verificar es acto de la agencia: una modelo no firma su propio expediente.
create policy compliance_insert on public.compliance_records
  for insert to authenticated
  with check (app.can_manage_org(organization_id));

create policy compliance_update on public.compliance_records
  for update to authenticated
  using (app.can_manage_org(organization_id))
  with check (app.can_manage_org(organization_id));

create policy compliance_delete on public.compliance_records
  for delete to authenticated
  using (app.is_platform_admin());

-- --- media_assets ------------------------------------------------------------
create policy media_assets_select on public.media_assets
  for select to authenticated
  using (app.can_read_profile(profile_id, organization_id));

create policy media_assets_insert on public.media_assets
  for insert to authenticated
  with check (app.can_write_profile(profile_id, organization_id));

create policy media_assets_update on public.media_assets
  for update to authenticated
  using (app.can_write_profile(profile_id, organization_id))
  with check (app.can_write_profile(profile_id, organization_id));

create policy media_assets_delete on public.media_assets
  for delete to authenticated
  using (app.can_manage_org(organization_id) or app.owns_profile(profile_id));

-- --- upload_links ------------------------------------------------------------
create policy upload_links_select on public.upload_links
  for select to authenticated
  using (app.can_read_profile(profile_id, organization_id));

create policy upload_links_insert on public.upload_links
  for insert to authenticated
  with check (app.can_write_profile(profile_id, organization_id));

-- Revocar es lo que mas se usa aqui, y debe poder hacerlo cualquiera que vea el
-- enlace: ante una fuga, cerrar rapido importa mas que la jerarquia.
create policy upload_links_update on public.upload_links
  for update to authenticated
  using (app.can_write_profile(profile_id, organization_id))
  with check (app.can_write_profile(profile_id, organization_id));

create policy upload_links_delete on public.upload_links
  for delete to authenticated
  using (app.can_manage_org(organization_id));

-- Bitacora de auditoria: se lee, no se escribe ni se corrige desde el cliente.
create policy upload_link_events_select on public.upload_link_events
  for select to authenticated
  using (exists (
    select 1 from public.upload_links ul
    where ul.id = upload_link_id
      and app.can_read_profile(ul.profile_id, ul.organization_id)
  ));

-- --- scheduling_rules --------------------------------------------------------
create policy scheduling_rules_select on public.scheduling_rules
  for select to authenticated
  using (app.is_org_member(organization_id));

create policy scheduling_rules_update on public.scheduling_rules
  for update to authenticated
  using (app.can_manage_org(organization_id))
  with check (app.can_manage_org(organization_id));

-- --- schedules ---------------------------------------------------------------
create policy schedules_select on public.schedules
  for select to authenticated
  using (app.can_read_profile(profile_id, organization_id));

create policy schedules_insert on public.schedules
  for insert to authenticated
  with check (app.can_write_profile(profile_id, organization_id));

create policy schedules_update on public.schedules
  for update to authenticated
  using (app.can_write_profile(profile_id, organization_id))
  with check (app.can_write_profile(profile_id, organization_id));

create policy schedules_delete on public.schedules
  for delete to authenticated
  using (app.can_write_profile(profile_id, organization_id));

-- --- platform_credentials ----------------------------------------------------
-- Guardan secretos cifrados. El editor no entra, ni siquiera a la lista.
create policy platform_credentials_select on public.platform_credentials
  for select to authenticated
  using (
    app.can_manage_org(organization_id)
    or (profile_id is not null and app.is_org_member(organization_id) and app.owns_profile(profile_id))
  );

create policy platform_credentials_insert on public.platform_credentials
  for insert to authenticated
  with check (
    app.can_manage_org(organization_id)
    or (profile_id is not null and app.is_org_member(organization_id) and app.owns_profile(profile_id))
  );

create policy platform_credentials_update on public.platform_credentials
  for update to authenticated
  using (
    app.can_manage_org(organization_id)
    or (profile_id is not null and app.is_org_member(organization_id) and app.owns_profile(profile_id))
  )
  with check (
    app.can_manage_org(organization_id)
    or (profile_id is not null and app.is_org_member(organization_id) and app.owns_profile(profile_id))
  );

create policy platform_credentials_delete on public.platform_credentials
  for delete to authenticated
  using (app.can_manage_org(organization_id));

-- --- jobs --------------------------------------------------------------------
-- Solo lectura para el panel de operacion. Encolar y cerrar trabajos es cosa del
-- servidor y de los workers, con clave de servicio.
create policy jobs_select on public.jobs
  for select to authenticated
  using (app.can_ingest_org(organization_id));

-- --- tracking_links ----------------------------------------------------------
create policy tracking_links_select on public.tracking_links
  for select to authenticated
  using (app.can_read_profile(profile_id, organization_id));

create policy tracking_links_insert on public.tracking_links
  for insert to authenticated
  with check (app.can_write_profile(profile_id, organization_id));

create policy tracking_links_update on public.tracking_links
  for update to authenticated
  using (app.can_write_profile(profile_id, organization_id))
  with check (app.can_write_profile(profile_id, organization_id));

create policy tracking_links_delete on public.tracking_links
  for delete to authenticated
  using (app.can_manage_org(organization_id));

-- --- link_clicks -------------------------------------------------------------
-- Se leen a traves del enlace padre. Insertar es exclusivo del RPC publico, que
-- es SECURITY DEFINER: sin politica de INSERT, nadie mas puede inflar metricas.
create policy link_clicks_select on public.link_clicks
  for select to authenticated
  using (exists (
    select 1 from public.tracking_links tl
    where tl.id = tracking_link_id
      and app.can_read_profile(tl.profile_id, tl.organization_id)
  ));

-- --- financial_records -------------------------------------------------------
create policy financial_select on public.financial_records
  for select to authenticated
  using (app.can_read_financials(profile_id, organization_id));

create policy financial_insert on public.financial_records
  for insert to authenticated
  with check (app.can_manage_org(organization_id));

create policy financial_update on public.financial_records
  for update to authenticated
  using (app.can_manage_org(organization_id))
  with check (app.can_manage_org(organization_id));

create policy financial_delete on public.financial_records
  for delete to authenticated
  using (app.is_platform_admin());
