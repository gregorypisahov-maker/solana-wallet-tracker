-- paper-trader tables: replaces local JSON storage, which would be wiped
-- on every Railway redeploy since the container filesystem is ephemeral.

create table if not exists paper_state (
  id int primary key default 1,
  bankroll_sol numeric not null,
  daily_start_bankroll_sol numeric not null,
  daily_reset_date text not null,
  consecutive_losses int not null default 0,
  halted boolean not null default false,
  halt_reason text
);

create table if not exists paper_positions (
  mint text primary key,
  token_symbol text not null,
  entry_price numeric not null,
  entry_time timestamptz not null,
  size_sol numeric not null,
  remaining_pct numeric not null,
  peak_multiple numeric not null,
  ladder_hits jsonb not null default '[]',
  entry_alert jsonb not null
);

create table if not exists paper_trades (
  id bigint generated always as identity primary key,
  token_symbol text not null,
  mint text not null,
  type text not null,
  reason text not null,
  entry_price numeric not null,
  exit_price numeric not null,
  multiple numeric not null,
  sold_pct numeric not null,
  sold_size_sol numeric not null,
  proceeds_sol numeric not null,
  pnl_sol numeric not null,
  hold_minutes numeric not null,
  happened_at timestamptz not null default now(),
  entry_alert jsonb not null
);

create index if not exists paper_trades_happened_at_idx on paper_trades (happened_at);
create index if not exists paper_trades_mint_idx on paper_trades (mint);
