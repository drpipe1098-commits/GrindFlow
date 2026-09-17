-- =============================================================================
-- 001600 — Motor de publicacion (Modulo 5)
-- =============================================================================

alter table public.schedules
  -- Identificador y URL del post en la plataforma. Sin esto no se puede
  -- comprobar despues si sigue publicado ni enlazarlo desde el panel.
  add column external_post_id text,
  add column external_url text;

-- -----------------------------------------------------------------------------
-- Suspension de envios por perfil y red
-- -----------------------------------------------------------------------------
-- Cuando una plataforma responde 401, el token dejo de valer: la cuenta fue
-- revocada, suspendida o le cambiaron la contrasena. Seguir intentando con el
-- resto de publicaciones programadas de ese perfil es la forma mas rapida de
-- convertir un problema de credenciales en un baneo: veinte peticiones fallidas
-- seguidas contra una API es exactamente el patron que las plataformas castigan.
--
-- Por eso el fallo de una publicacion suspende TODAS las de ese perfil hacia esa
-- red. Es por perfil y red, no global: que el Telegram de una modelo caiga no
-- debe parar su X ni el Telegram de sus companeras.
create table public.publish_suspensions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  profile_id        uuid not null,
  platform          public.platform not null,

  reason            text not null,
  last_error        text,
  suspended_at      timestamptz not null default now(),
  -- Momento en que se levanta sola. NULL significa que hace falta intervencion
  -- manual: un token revocado no se arregla esperando.
  until             timestamptz,
  -- Quien la levanto a mano, si fue el caso.
  lifted_at         timestamptz,
  lifted_by         uuid references public.users (id) on delete set null,

  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete cascade
);

create index publish_suspensions_lookup_idx
  on public.publish_suspensions (profile_id, platform, lifted_at);
create index publish_suspensions_org_idx
  on public.publish_suspensions (organization_id, suspended_at desc);

-- Una sola suspension viva por perfil y red.
create unique index publish_suspensions_one_live
  on public.publish_suspensions (profile_id, platform)
  where lifted_at is null;

/**
 * True si los envios de ese perfil a esa red estan suspendidos ahora mismo.
 *
 * Una suspension con `until` en el pasado ya no cuenta: se levanta sola sin que
 * nadie tenga que hacer nada. Una con `until` nulo sigue viva hasta que alguien
 * la levante, que es el caso del token revocado.
 */
create or replace function app.is_publishing_suspended(
  p_profile uuid,
  p_platform public.platform
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.publish_suspensions s
    where s.profile_id = p_profile
      and s.platform = p_platform
      and s.lifted_at is null
      and (s.until is null or s.until > now())
  );
$$;

-- -----------------------------------------------------------------------------
-- Aplazamiento explicito de un trabajo
-- -----------------------------------------------------------------------------
-- `app.complete_job` reprograma con espera exponencial calculada por la base.
-- Sirve para casi todo, pero no para un 429: ahi la plataforma DICE cuanto hay
-- que esperar, en la cabecera `Retry-After`, y adivinar un valor propio es
-- ignorar la unica informacion fiable que existe. Ignorarla suele costar otro
-- 429 y, repetido, un bloqueo mas largo.
create or replace function app.defer_job(
  p_job_id  uuid,
  p_seconds int,
  p_error   text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update public.jobs
     set status     = 'pending',
         run_after  = now() + make_interval(secs => greatest(p_seconds, 1)),
         last_error = p_error,
         -- El intento no se cuenta: esperar porque la plataforma lo pidio no es
         -- un fallo del trabajo, y gastarle un intento haria que una racha de
         -- 429 lo diera por muerto sin haberlo intentado de verdad.
         attempts   = greatest(attempts - 1, 0),
         updated_at = now()
   where id = p_job_id;
end;
$$;

create or replace function public.defer_job(
  p_job_id  uuid,
  p_seconds int,
  p_error   text default null
)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select app.defer_job(p_job_id, p_seconds, p_error);
$$;

revoke all on function public.defer_job(uuid, int, text) from public;
grant execute on function public.defer_job(uuid, int, text) to service_role;

-- Envoltorio publico para el worker de Node, que entra por PostgREST.
create or replace function public.is_publishing_suspended(
  p_profile uuid,
  p_platform public.platform
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.is_publishing_suspended(p_profile, p_platform);
$$;

revoke all on function public.is_publishing_suspended(uuid, public.platform) from public;
grant execute on function public.is_publishing_suspended(uuid, public.platform) to service_role;

-- -----------------------------------------------------------------------------
-- Dar un trabajo por muerto sin agotar los intentos
-- -----------------------------------------------------------------------------
-- `app.complete_job` reintenta hasta agotar `max_attempts`, que es lo correcto
-- para un fallo pasajero. Pero un texto que la plataforma rechaza por invalido, o
-- un publicador que no existe, van a fallar exactamente igual las cinco veces:
-- reintentarlos gasta cuota de la API y retrasa el momento de enterarse.
create or replace function app.kill_job(p_job_id uuid, p_error text)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.jobs
     set status = 'dead', last_error = p_error, updated_at = now()
   where id = p_job_id;
$$;

create or replace function public.kill_job(p_job_id uuid, p_error text)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select app.kill_job(p_job_id, p_error);
$$;

revoke all on function public.kill_job(uuid, text) from public;
grant execute on function public.kill_job(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- Un solo trabajo de publicacion vivo por programacion
-- -----------------------------------------------------------------------------
-- Mismo motivo que el del escaneo, con una consecuencia peor: dos trabajos vivos
-- para la misma fila de `schedules` publican el mismo contenido dos veces en la
-- cuenta de la modelo.
create unique index jobs_one_live_publish_per_schedule
  on public.jobs ((payload ->> 'schedule_id'))
  where job_type = 'publish' and status in ('pending', 'claimed');

-- Programaciones que ya toca publicar. La usa el despachador del worker.
create index schedules_due_now_idx
  on public.schedules (scheduled_at)
  where status = 'queued';

alter table public.publish_suspensions enable row level security;

-- Recordatorio: una tabla nueva nace sin privilegios para `authenticated`. El
-- `alter default privileges` de la migracion 001200 cubre las creadas despues,
-- pero se concede explicitamente para no depender de ese efecto a distancia.
grant select, insert, update, delete on public.publish_suspensions to authenticated;

-- El equipo de la agencia y la propia modelo ven por que se paro su cuenta.
create policy publish_suspensions_select on public.publish_suspensions
  for select to authenticated
  using (app.can_read_profile(profile_id, organization_id));

-- Levantarla a mano es decision de la agencia: implica haber reconectado la
-- cuenta, y el editor no tiene acceso a las credenciales.
create policy publish_suspensions_update on public.publish_suspensions
  for update to authenticated
  using (app.can_manage_org(organization_id))
  with check (app.can_manage_org(organization_id));

-- Sin politica de INSERT: las crea el worker con la clave de servicio, al
-- recibir el 401. Que un cliente pudiera crearlas seria darle un boton para
-- parar las publicaciones de otra persona.
