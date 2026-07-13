-- Run once in the Supabase SQL editor before deploying this branch.
-- Idempotent: it is safe to run again.

create extension if not exists "uuid-ossp";

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

alter table paper_positions add column if not exists position_id text;
alter table paper_positions add column if not exists realized_pnl_sol numeric not null default 0;
alter table paper_trades add column if not exists position_id text;

update paper_positions
set position_id = mint || '_' || floor(extract(epoch from entry_time) * 1000)::bigint::text
where position_id is null;

create index if not exists paper_positions_position_id_idx on paper_positions(position_id);
create index if not exists paper_trades_position_id_idx on paper_trades(position_id);
create index if not exists paper_trades_happened_at_idx on paper_trades(happened_at desc);

create table if not exists alert_participants (
  id bigint generated always as identity primary key,
  token_mint text not null,
  wallet_address text not null,
  alert_sent_at timestamptz not null,
  sol_amount numeric not null default 0,
  created_at timestamptz not null default now(),
  unique(token_mint, wallet_address, alert_sent_at)
);
create index if not exists alert_participants_wallet_idx on alert_participants(wallet_address);
create index if not exists alert_participants_token_time_idx on alert_participants(token_mint, alert_sent_at desc);

create table if not exists wallet_performance (
  wallet_address text primary key,
  alerts_count int not null default 0,
  completed_trades int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  win_rate numeric not null default 0,
  average_return numeric not null default 0,
  realized_pnl_sol numeric not null default 0,
  profit_factor numeric,
  max_drawdown numeric not null default 0,
  avg_entry_timing_minutes numeric,
  rugged_or_heavy_loss_count int not null default 0,
  losing_alert_participation_pct numeric not null default 0,
  trust_score numeric not null default 50,
  last_activity_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists wallet_performance_trust_idx on wallet_performance(trust_score desc);

-- The application and workers use only the server-side service-role key.
-- RLS prevents accidental exposure if an anonymous Supabase key is used elsewhere.
alter table if exists wallets enable row level security;
alter table if exists wallet_transactions enable row level security;
alter table if exists token_scores enable row level security;
alter table if exists alerts_sent enable row level security;
alter table paper_state enable row level security;
alter table paper_positions enable row level security;
alter table paper_trades enable row level security;
alter table alert_participants enable row level security;
alter table wallet_performance enable row level security;
