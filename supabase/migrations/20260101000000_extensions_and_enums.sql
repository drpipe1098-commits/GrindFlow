-- =============================================================================
-- 000000 — Extensiones, esquema interno y tipos enumerados
-- =============================================================================
-- El esquema `app` guarda las funciones auxiliares de autorizacion. Vive aparte
-- de `public` para que no quede expuesto por PostgREST: nada de lo que hay aqui
-- debe ser invocable desde el cliente.

create extension if not exists "pgcrypto";

create schema if not exists app;
revoke all on schema app from public;

-- Rol principal del usuario en la plataforma. Determina el panel al que aterriza.
-- La autorizacion efectiva sobre los datos la decide `memberships.role`, que es
-- por organizacion: el mismo usuario puede ser 'studio' en una agencia y 'model'
-- en la suya propia.
create type public.user_role as enum ('admin', 'studio', 'model', 'editor');

-- Una agencia con varias modelos, o una modelo independiente que es su propia
-- organizacion. En ambos casos el aislamiento se hace por organization_id.
create type public.org_type as enum ('studio', 'independent');

create type public.media_type as enum ('image', 'video');

-- Ciclo de vida de un asset dentro del vault.
create type public.asset_status as enum ('raw', 'edited', 'scheduled', 'published', 'archived');

create type public.platform as enum ('telegram', 'x', 'reddit', 'bluesky', 'webhook');

-- Como se autentica la plataforma de destino. OAuth trae tokens que caducan y
-- se refrescan; una API key es un secreto estatico.
create type public.credential_type as enum ('oauth', 'api_key');

create type public.schedule_status as enum ('queued', 'publishing', 'published', 'failed', 'cancelled');

create type public.job_type as enum ('sanitize_exif', 'watermark', 'transcode', 'generate_teaser', 'publish');

create type public.job_status as enum ('pending', 'claimed', 'done', 'failed', 'dead');

-- Estado del expediente 2257 de una modelo. Sin 'verified' vigente no se puede
-- programar ni publicar nada suyo (lo impone un trigger, no la interfaz).
create type public.compliance_status as enum ('pending', 'verified', 'expired', 'rejected');

create type public.payout_status as enum ('pending', 'approved', 'paid', 'disputed');
