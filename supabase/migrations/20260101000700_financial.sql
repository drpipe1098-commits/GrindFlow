-- =============================================================================
-- 000700 — Libro de reparto de ingresos
-- =============================================================================

create table public.financial_records (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  profile_id       uuid not null,

  period_start     date not null,
  period_end       date not null,

  gross_amount     numeric(12,2) not null default 0 check (gross_amount >= 0),
  agency_fee       numeric(12,2) not null default 0 check (agency_fee >= 0),
  -- Calculado por la base: el neto de la modelo no depende de que la aplicacion
  -- haga bien la resta.
  net_amount       numeric(12,2) generated always as (gross_amount - agency_fee) stored,
  currency         char(3) not null default 'USD',

  payout_status    public.payout_status not null default 'pending',
  paid_at          timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),

  foreign key (profile_id, organization_id)
    references public.profiles (id, organization_id) on delete cascade,

  constraint financial_period_ordered check (period_end >= period_start),
  -- La comision nunca puede superar lo facturado.
  constraint financial_fee_within_gross check (agency_fee <= gross_amount),
  -- Un periodo pagado necesita fecha de pago.
  constraint financial_paid_needs_date check (payout_status <> 'paid' or paid_at is not null),

  -- Un unico registro por perfil y periodo: impide duplicar una liquidacion.
  unique (profile_id, period_start, period_end)
);

create index financial_org_idx on public.financial_records (organization_id, period_start desc);
create index financial_profile_idx on public.financial_records (profile_id, period_start desc);

alter table public.financial_records enable row level security;
