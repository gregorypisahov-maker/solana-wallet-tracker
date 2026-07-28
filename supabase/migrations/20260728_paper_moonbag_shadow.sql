-- Isolated, additive paper-only moonbag experiment.
-- Rollback is safe: set PAPER_MOONBAG_SHADOW_ENABLED=false. The existing
-- AI discovery/capital tables and live executor are never modified.

create table if not exists public.ai_moonbag_shadow_positions (
  id uuid primary key default gen_random_uuid(),
  source_trade_id text not null unique,
  source_position_id text not null,
  mint text not null,
  token_symbol text not null,
  pair_address text not null,
  original_entry_price_usd numeric not null,
  retention_started_price_usd numeric not null,
  last_price_usd numeric not null,
  peak_price_usd numeric not null,
  source_size_sol numeric not null,
  retained_fraction numeric not null default 0.15,
  retained_cost_sol numeric not null,
  main_locked_proceeds_sol numeric not null,
  source_closed_at timestamptz not null,
  opened_at timestamptz not null default now(),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_moonbag_shadow_trades (
  id uuid primary key default gen_random_uuid(),
  source_trade_id text not null unique,
  source_position_id text not null,
  mint text not null,
  token_symbol text not null,
  pair_address text not null,
  source_size_sol numeric not null,
  retained_fraction numeric not null,
  retained_cost_sol numeric not null,
  main_locked_proceeds_sol numeric not null,
  moonbag_proceeds_sol numeric not null,
  combined_proceeds_sol numeric not null,
  combined_pnl_sol numeric not null,
  combined_return_pct numeric not null,
  original_entry_price_usd numeric not null,
  retention_started_price_usd numeric not null,
  exit_price_usd numeric not null,
  peak_price_usd numeric not null,
  peak_multiple numeric not null,
  exit_multiple numeric not null,
  exit_reason text not null,
  source_closed_at timestamptz not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now(),
  snapshot jsonb not null default '{}'::jsonb
);

create index if not exists ai_moonbag_shadow_positions_opened_idx
  on public.ai_moonbag_shadow_positions(opened_at);
create index if not exists ai_moonbag_shadow_trades_closed_idx
  on public.ai_moonbag_shadow_trades(closed_at desc);

alter table public.ai_moonbag_shadow_positions enable row level security;
alter table public.ai_moonbag_shadow_trades enable row level security;

comment on table public.ai_moonbag_shadow_positions is
  'Paper-only shadow positions; does not affect source paper accounting or live execution.';
comment on table public.ai_moonbag_shadow_trades is
  'Hypothetical 85/15 main-plus-moonbag outcomes for rollback-safe experimentation.';