-- =============================================================================
-- 000600 — Enlaces cortos, atribucion y analitica de clics
-- =============================================================================

create table public.tracking_links (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  profile_id        uuid not null,
  asset_id          uuid,

  -- Lo que va despues de /l/ en la URL.
  slug              text not null unique check (slug ~ '^[a-zA-Z0-9_-]{4,64}$'),
  destination_url   text not null check (destination_url ~ '^https://'),

  campaign          text,
  -- Red de origen: de donde viene el trafico que entra por este enlace.
  network           public.platform,

  clicks_count      bigint not null default 0 check (clicks_count >= 0),
  active            bool not null default true,
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),

  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete cascade,
  foreign key (asset_id, profile_id)
    references public.media_assets (id, profile_id) on delete set null
);

create index tracking_links_org_idx on public.tracking_links (organization_id);
create index tracking_links_profile_idx on public.tracking_links (profile_id);

-- Un clic por fila. El agregado `clicks_count` se mantiene al dia para que el
-- panel no tenga que contar millones de filas en cada carga.
create table public.link_clicks (
  id                 bigint generated always as identity primary key,
  tracking_link_id   uuid not null references public.tracking_links (id) on delete cascade,
  occurred_at        timestamptz not null default now(),
  -- ISO-3166 alfa-2, tomado de la cabecera geo del borde.
  country            char(2),
  referrer           text,
  ua_family          text,
  network            public.platform
);

create index link_clicks_link_time_idx on public.link_clicks (tracking_link_id, occurred_at desc);
create index link_clicks_country_idx on public.link_clicks (tracking_link_id, country);

-- -----------------------------------------------------------------------------
-- Camino publico del redirector
-- -----------------------------------------------------------------------------
-- El middleware resuelve el destino sin sesion. No se abre `tracking_links` a
-- `anon`: se exponen dos funciones SECURITY DEFINER de superficie minima, que
-- devuelven solo lo imprescindible y nunca revelan a que organizacion pertenece
-- el enlace.
create or replace function public.resolve_tracking_link(p_slug text)
returns table (destination_url text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tl.destination_url
  from public.tracking_links tl
  where tl.slug = p_slug
    and tl.active
    and (tl.expires_at is null or tl.expires_at > now())
  limit 1;
$$;

-- Registro asincrono del clic: el middleware ya redirigio al visitante cuando
-- esto se ejecuta, asi que la escritura nunca esta en el camino critico.
-- Se identifica por slug, no por id, para que nadie pueda inflar el contador de
-- un enlace ajeno enumerando identificadores.
create or replace function public.record_link_click(
  p_slug       text,
  p_country    text default null,
  p_referrer   text default null,
  p_ua_family  text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_link public.tracking_links;
begin
  select * into v_link
  from public.tracking_links
  where slug = p_slug and active
  for update;

  if not found then
    return;
  end if;

  insert into public.link_clicks (tracking_link_id, country, referrer, ua_family, network)
  values (
    v_link.id,
    nullif(upper(left(coalesce(p_country, ''), 2)), ''),
    left(coalesce(p_referrer, ''), 500),
    left(coalesce(p_ua_family, ''), 100),
    v_link.network
  );

  update public.tracking_links
     set clicks_count = clicks_count + 1
   where id = v_link.id;
end;
$$;

revoke all on function public.resolve_tracking_link(text) from public;
revoke all on function public.record_link_click(text, text, text, text) from public;
grant execute on function public.resolve_tracking_link(text) to anon, authenticated;
grant execute on function public.record_link_click(text, text, text, text) to anon, authenticated;

alter table public.tracking_links enable row level security;
alter table public.link_clicks    enable row level security;
