create table if not exists public.token_intelligence_outcomes (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.token_intelligence_snapshots(id) on delete cascade,
  mint text not null,
  signal_version text not null,
  analyzed_at timestamptz not null,
  horizon_minutes integer not null check (horizon_minutes in (5, 15, 30, 60, 240, 1440)),
  measured_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'measured', 'failed')),
  entry_price_usd numeric,
  measured_price_usd numeric,
  price_return numeric,
  max_drawdown numeric,
  max_runup numeric,
  liquidity_change numeric,
  sellability boolean,
  liquidity_removed boolean,
  rug_detected boolean,
  survived boolean,
  outcome_label text,
  evidence jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_id, horizon_minutes)
);

create index if not exists token_intelligence_outcomes_due_idx
  on public.token_intelligence_outcomes (status, analyzed_at, horizon_minutes);

create index if not exists token_intelligence_outcomes_mint_idx
  on public.token_intelligence_outcomes (mint, analyzed_at desc);

alter table public.token_intelligence_outcomes enable row level security;

comment on table public.token_intelligence_outcomes is
  'Forward measurements used to validate whether Helius intelligence features predict rugs or durable winners.';

comment on column public.token_intelligence_outcomes.evidence is
  'Raw measurement evidence; outcome labels must remain derived and auditable.';
