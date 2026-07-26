create table if not exists public.ai_trade_autopsies (
  id bigserial primary key,
  trade_id bigint not null references public.ai_discovery_trades(id) on delete cascade,
  position_id text not null,
  mint text not null,
  token_symbol text not null,
  exit_reason text not null,
  net_return_pct numeric not null,
  pnl_sol numeric not null,
  held_seconds integer not null,
  entry_score numeric,
  entry_liquidity_usd numeric,
  exit_liquidity_usd numeric,
  liquidity_change_pct numeric,
  entry_momentum_m5 numeric,
  exit_momentum_m5 numeric,
  peak_return_pct numeric,
  giveback_from_peak_pct numeric,
  verdict text not null,
  preventable boolean not null default false,
  estimated_better_exit_pct numeric,
  confidence numeric not null,
  positive_signals jsonb not null default '[]'::jsonb,
  negative_signals jsonb not null default '[]'::jsonb,
  explanation text not null,
  model_version text not null default 'autopsy_v1_2026_07_26',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trade_id)
);

create index if not exists ai_trade_autopsies_created_at_idx on public.ai_trade_autopsies(created_at desc);
create index if not exists ai_trade_autopsies_mint_idx on public.ai_trade_autopsies(mint);

alter table public.ai_trade_autopsies enable row level security;
