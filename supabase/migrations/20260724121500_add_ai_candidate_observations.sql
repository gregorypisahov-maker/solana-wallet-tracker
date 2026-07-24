create table if not exists public.ai_candidate_observations (
  id bigint generated always as identity primary key,
  mint text not null,
  token_symbol text not null,
  pair_address text not null,
  observed_at timestamptz not null default now(),
  source_last_seen_at timestamptz,
  features jsonb not null default '{}'::jsonb,
  rules_passed boolean not null default false,
  decision text not null check (decision in ('enter','reject','observe')),
  rejection_reasons text[] not null default '{}',
  baseline_probability numeric,
  model_version text not null default 'baseline_v1',
  entered boolean not null default false,
  entry_price_usd numeric,
  price_5m_usd numeric,
  return_5m_pct numeric,
  price_15m_usd numeric,
  return_15m_pct numeric,
  price_30m_usd numeric,
  return_30m_pct numeric,
  price_45m_usd numeric,
  return_45m_pct numeric,
  outcome_complete boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists ai_candidate_observations_due_idx
  on public.ai_candidate_observations (outcome_complete, observed_at);

create index if not exists ai_candidate_observations_mint_idx
  on public.ai_candidate_observations (mint, observed_at desc);

alter table public.ai_candidate_observations enable row level security;

comment on table public.ai_candidate_observations is
  'Paper-only AI training dataset: accepted and rejected market candidates with later price outcomes.';
