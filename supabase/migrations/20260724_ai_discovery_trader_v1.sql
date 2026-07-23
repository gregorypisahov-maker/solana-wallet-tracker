create table if not exists public.ai_discovery_state (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  halted boolean not null default false,
  halt_reason text,
  bankroll_sol numeric not null default 1,
  starting_bankroll_sol numeric not null default 1,
  entries_today integer not null default 0,
  daily_date date not null default (now() at time zone 'utc')::date,
  daily_realized_pnl_sol numeric not null default 0,
  consecutive_losses integer not null default 0,
  last_scan_at timestamptz,
  last_entry_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.ai_discovery_state (id) values (1)
on conflict (id) do nothing;

create table if not exists public.ai_discovery_positions (
  position_id text primary key,
  mint text not null,
  token_symbol text not null,
  pair_address text not null,
  entry_price_usd numeric not null,
  last_price_usd numeric not null,
  peak_price_usd numeric not null,
  size_sol numeric not null,
  opened_at timestamptz not null,
  last_checked_at timestamptz,
  entry_snapshot jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_discovery_trades (
  id bigint generated always as identity primary key,
  position_id text not null,
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
  entry_snapshot jsonb not null default '{}'::jsonb,
  exit_snapshot jsonb not null default '{}'::jsonb
);

create index if not exists ai_discovery_trades_closed_idx on public.ai_discovery_trades (closed_at desc);
create index if not exists ai_discovery_trades_mint_idx on public.ai_discovery_trades (mint, closed_at desc);
create index if not exists ai_discovery_positions_opened_idx on public.ai_discovery_positions (opened_at);

alter table public.ai_discovery_state enable row level security;
alter table public.ai_discovery_positions enable row level security;
alter table public.ai_discovery_trades enable row level security;

revoke all on public.ai_discovery_state from anon, authenticated;
revoke all on public.ai_discovery_positions from anon, authenticated;
revoke all on public.ai_discovery_trades from anon, authenticated;
