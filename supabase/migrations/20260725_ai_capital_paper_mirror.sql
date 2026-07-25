-- Paper-only 5x accounting mirror for the existing AI discovery paper trader.
-- No wallet keys, signing, swaps, or real-money execution are involved.

create table if not exists public.ai_capital_state (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  halted boolean not null default false,
  halt_reason text,
  bankroll_sol numeric not null default 5,
  starting_bankroll_sol numeric not null default 5,
  entries_today integer not null default 0,
  daily_date date not null default (now() at time zone 'utc')::date,
  daily_realized_pnl_sol numeric not null default 0,
  consecutive_losses integer not null default 0,
  last_sync_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.ai_capital_state (id, bankroll_sol, starting_bankroll_sol)
values (1, 5, 5)
on conflict (id) do nothing;

create table if not exists public.ai_capital_positions (
  position_id text primary key,
  source_position_id text not null unique,
  mint text not null,
  token_symbol text not null,
  pair_address text not null,
  entry_price_usd numeric not null,
  last_price_usd numeric not null,
  peak_price_usd numeric not null,
  size_sol numeric not null default 1,
  opened_at timestamptz not null,
  source_size_sol numeric not null,
  entry_snapshot jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_capital_trades (
  id bigint generated always as identity primary key,
  position_id text not null unique,
  source_position_id text not null unique,
  mint text not null,
  token_symbol text not null,
  pair_address text not null,
  entry_price_usd numeric not null,
  exit_price_usd numeric not null,
  size_sol numeric not null,
  gross_return_pct numeric not null,
  net_return_pct numeric not null,
  pnl_sol numeric not null,
  exit_reason text not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  source_trade_id bigint,
  entry_snapshot jsonb not null default '{}'::jsonb,
  exit_snapshot jsonb not null default '{}'::jsonb
);

create index if not exists ai_capital_trades_closed_idx on public.ai_capital_trades (closed_at desc);
create index if not exists ai_capital_positions_opened_idx on public.ai_capital_positions (opened_at);

alter table public.ai_capital_state enable row level security;
alter table public.ai_capital_positions enable row level security;
alter table public.ai_capital_trades enable row level security;

revoke all on public.ai_capital_state from anon, authenticated;
revoke all on public.ai_capital_positions from anon, authenticated;
revoke all on public.ai_capital_trades from anon, authenticated;
