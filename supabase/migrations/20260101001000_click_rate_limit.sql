-- =============================================================================
-- 001000 — Limite de tasa del acortador
-- =============================================================================
-- `record_link_click` es invocable por `anon`: es lo que permite contar clics de
-- visitantes sin sesion. El precio es que cualquiera que conozca un slug puede
-- llamarla en bucle e inflar las metricas de una modelo — y sobre esas metricas
-- se reparte dinero.
--
-- La barrera vive aqui, en la base, y no solo en el middleware, porque el
-- middleware corre en varias replicas con memoria separada y ademas se puede
-- rodear llamando al RPC directamente.

alter table public.link_clicks
  add column ip_hash text;

comment on column public.link_clicks.ip_hash is
  'SHA-256 de la IP con sal del entorno. Nunca se guarda la direccion en claro: '
  'el hash basta para contar y limitar, y sin la sal un volcado de la base no '
  'permite recuperarla.';

-- Indice del camino caliente: la comprobacion de ventana en cada clic.
create index link_clicks_dedupe_idx
  on public.link_clicks (tracking_link_id, ip_hash, occurred_at desc);

-- La firma anterior no llevaba ip_hash.
drop function if exists public.record_link_click(text, text, text, text);

create or replace function public.record_link_click(
  p_slug       text,
  p_country    text default null,
  p_referrer   text default null,
  p_ua_family  text default null,
  p_ip_hash    text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  -- Ventana de deduplicacion. Es una constante del cuerpo de la funcion, NO un
  -- parametro: si el llamante pudiera elegirla, bastaria pasar 0 para anular el
  -- limite, y quien llama es anonimo. Cambiarla exige una migracion.
  c_window    constant interval := interval '60 seconds';
  v_link      public.tracking_links;
  v_ip_hash   text;
begin
  select * into v_link
  from public.tracking_links
  where slug = p_slug and active
  for update;

  if not found then
    return false;
  end if;

  -- Sin hash de IP todos los clics caen en un mismo cubo compartido y se limitan
  -- juntos. Degrada de forma segura: un llamante que omita el parametro no
  -- consigue saltarse el limite, consigue el mas estricto de todos.
  v_ip_hash := coalesce(nullif(btrim(p_ip_hash), ''), 'sin-ip');

  -- Ya se conto un clic de esta IP sobre este enlace dentro de la ventana.
  if exists (
    select 1
    from public.link_clicks lc
    where lc.tracking_link_id = v_link.id
      and lc.ip_hash = v_ip_hash
      and lc.occurred_at > now() - c_window
  ) then
    return false;
  end if;

  insert into public.link_clicks
    (tracking_link_id, country, referrer, ua_family, network, ip_hash)
  values (
    v_link.id,
    nullif(upper(left(coalesce(p_country, ''), 2)), ''),
    left(coalesce(p_referrer, ''), 500),
    left(coalesce(p_ua_family, ''), 100),
    v_link.network,
    v_ip_hash
  );

  update public.tracking_links
     set clicks_count = clicks_count + 1
   where id = v_link.id;

  return true;
end;
$$;

revoke all on function public.record_link_click(text, text, text, text, text) from public;
grant execute on function public.record_link_click(text, text, text, text, text)
  to anon, authenticated;
