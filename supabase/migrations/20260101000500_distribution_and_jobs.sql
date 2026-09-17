-- =============================================================================
-- 000500 — Credenciales de plataforma y cola de trabajos
-- =============================================================================

-- Una fila por cuenta conectada. Soporta las dos formas de autenticacion que
-- usan las plataformas del proyecto:
--   * oauth   — X/Twitter, Reddit, Bluesky: access token que caduca y refresh token.
--   * api_key — Telegram Bot API y webhooks propios: secreto estatico.
-- Los secretos NO se guardan en claro: el cifrado se hace en el servidor antes
-- de escribir (ver src/lib/crypto/secrets.ts). La base solo ve texto cifrado.
create table public.platform_credentials (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  -- Nula cuando la cuenta es de la agencia; con valor cuando es de una modelo.
  profile_id           uuid,

  platform             public.platform not null,
  credential_type      public.credential_type not null,
  label                text not null,

  -- Identificador publico de la cuenta destino: @handle, id de canal, subreddit.
  account_identifier   text,

  -- Secretos cifrados en la aplicacion. api_key usa `secret_ciphertext`;
  -- oauth usa ademas refresh y expiracion.
  secret_ciphertext    text not null,
  refresh_ciphertext   text,
  token_expires_at     timestamptz,
  scopes               text[],

  -- Ajustes propios de cada destino: flair y subreddit en Reddit, id de canal en
  -- Telegram, cabeceras de firma en un webhook.
  settings             jsonb not null default '{}'::jsonb,

  active               bool not null default true,
  last_used_at         timestamptz,
  created_at           timestamptz not null default now(),

  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete cascade,

  -- OAuth sin caducidad declarada no es OAuth: obliga a modelar el refresco.
  constraint credential_oauth_needs_expiry check (
    credential_type <> 'oauth' or token_expires_at is not null
  )
);

create index platform_credentials_org_idx on public.platform_credentials (organization_id, platform);
create index platform_credentials_refresh_idx
  on public.platform_credentials (token_expires_at)
  where credential_type = 'oauth' and active;

-- -----------------------------------------------------------------------------
-- Cola de trabajos en Postgres
-- -----------------------------------------------------------------------------
-- Sin Redis ni broker: `FOR UPDATE SKIP LOCKED` da exclusion entre workers, y
-- vivir en la misma base hace que encolar sea transaccional con el cambio que lo
-- origina. Si la transaccion que crea el asset falla, su trabajo no queda huerfano.
create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  job_type         public.job_type not null,
  payload          jsonb not null default '{}'::jsonb,

  status           public.job_status not null default 'pending',
  priority         int not null default 100,
  attempts         int not null default 0,
  max_attempts     int not null default 5 check (max_attempts >= 1),

  -- Momento a partir del cual el trabajo es elegible. Lo usa el backoff.
  run_after        timestamptz not null default now(),
  claimed_at       timestamptz,
  claimed_by       text,
  last_error       text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Indice del camino caliente: el worker pregunta por trabajos elegibles.
create index jobs_claimable_idx
  on public.jobs (priority, run_after)
  where status = 'pending';

create index jobs_org_idx on public.jobs (organization_id, status);

-- Toma de trabajos. SKIP LOCKED deja que N workers consuman en paralelo sin
-- bloquearse entre si ni repartirse el mismo trabajo.
create or replace function app.claim_jobs(
  p_worker   text,
  p_batch    int default 1,
  p_types    public.job_type[] default null
)
returns setof public.jobs
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidates as (
    select j.id
    from public.jobs j
    where j.status = 'pending'
      and j.run_after <= now()
      and (p_types is null or j.job_type = any (p_types))
    order by j.priority, j.run_after
    limit greatest(p_batch, 1)
    for update skip locked
  )
  update public.jobs j
     set status     = 'claimed',
         claimed_at = now(),
         claimed_by = p_worker,
         attempts   = j.attempts + 1,
         updated_at = now()
    from candidates c
   where j.id = c.id
  returning j.*;
end;
$$;

-- Cierre de un trabajo. Con exito pasa a 'done'; con fallo reprograma con
-- backoff exponencial hasta agotar los intentos, y entonces cae a 'dead' para
-- que quede visible en el panel en vez de desaparecer.
create or replace function app.complete_job(
  p_job_id   uuid,
  p_success  bool,
  p_error    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts int;
  v_max      int;
begin
  select attempts, max_attempts into v_attempts, v_max
  from public.jobs where id = p_job_id for update;

  if not found then
    raise exception 'jobs: el trabajo % no existe', p_job_id;
  end if;

  if p_success then
    update public.jobs
       set status = 'done', last_error = null, updated_at = now()
     where id = p_job_id;
  elsif v_attempts >= v_max then
    update public.jobs
       set status = 'dead', last_error = p_error, updated_at = now()
     where id = p_job_id;
  else
    update public.jobs
       set status     = 'pending',
           last_error = p_error,
           -- 1, 2, 4, 8... minutos.
           run_after  = now() + (power(2, v_attempts) * interval '1 minute'),
           updated_at = now()
     where id = p_job_id;
  end if;
end;
$$;

alter table public.platform_credentials enable row level security;
alter table public.jobs                 enable row level security;
