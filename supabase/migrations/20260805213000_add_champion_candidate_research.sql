create table if not exists public.champion_strategy_state (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  paper_only boolean not null default true,
  active_version text not null default 'champion_research_v1_2026_08_05',
  mode text not null default 'research' check (mode in ('research','paper')),
  last_scan_at timestamptz,
  last_outcome_at timestamptz,
  halt_reason text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.champion_strategy_state (id) values (1)
on conflict (id) do nothing;

create table if not exists public.champion_candidates (
  candidate_id uuid primary key default gen_random_uuid(),
  strategy_version text not null,
  experiment_arm text not null default 'champion',
  mint text not null,
  token_symbol text,
  pair_address text,
  detected_at timestamptz not null,
  source text not null,
  decision text not null check (decision in ('accepted','rejected','observed')),
  decision_reasons text[] not null default '{}',
  score numeric,
  signal_price_usd numeric,
  executable_entry_price_usd numeric,
  executable_round_trip_cost_pct numeric,
  liquidity_usd numeric,
  market_cap_usd numeric,
  pool_age_minutes numeric,
  features jsonb not null default '{}'::jsonb,
  quote_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (strategy_version, experiment_arm, mint, detected_at)
);

create index if not exists champion_candidates_due_idx on public.champion_candidates (detected_at, candidate_id);
create index if not exists champion_candidates_version_decision_idx on public.champion_candidates (strategy_version, experiment_arm, decision, detected_at desc);
create index if not exists champion_candidates_mint_idx on public.champion_candidates (mint, detected_at desc);

create table if not exists public.champion_candidate_outcomes (
  candidate_id uuid not null references public.champion_candidates(candidate_id) on delete cascade,
  horizon_seconds integer not null check (horizon_seconds in (60,180,300,900,1800)),
  measured_at timestamptz not null,
  market_price_usd numeric,
  executable_exit_price_usd numeric,
  gross_return_pct numeric,
  executable_net_return_pct numeric,
  max_favorable_excursion_pct numeric,
  max_adverse_excursion_pct numeric,
  liquidity_usd numeric,
  route_available boolean,
  became_untradable boolean not null default false,
  target_hit_before_stop boolean,
  stop_hit_before_target boolean,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (candidate_id, horizon_seconds)
);

create index if not exists champion_outcomes_horizon_idx on public.champion_candidate_outcomes (horizon_seconds, measured_at desc);

alter table public.champion_strategy_state enable row level security;
alter table public.champion_candidates enable row level security;
alter table public.champion_candidate_outcomes enable row level security;

comment on table public.champion_candidates is 'Paper-only champion research candidates, including rejected setups, versioned for controlled experiments.';
comment on table public.champion_candidate_outcomes is 'Counterfactual forward outcomes at fixed horizons for accepted and rejected champion candidates.';
