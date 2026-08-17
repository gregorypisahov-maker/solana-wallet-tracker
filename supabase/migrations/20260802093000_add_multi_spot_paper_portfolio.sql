create table if not exists public.multi_spot_paper_accounts (
  symbol text primary key check (symbol in ('SOLUSDT','ETHUSDT','BTCUSDT')),
  enabled boolean not null default true,
  starting_bankroll_usdt numeric(20,6) not null default 1000 check (starting_bankroll_usdt > 0),
  cash_usdt numeric(20,6) not null default 1000 check (cash_usdt >= 0),
  realized_pnl_usdt numeric(20,6) not null default 0,
  entries_today integer not null default 0,
  daily_date date not null default current_date,
  daily_realized_pnl_usdt numeric(20,6) not null default 0,
  consecutive_losses integer not null default 0,
  halted boolean not null default false,
  halt_reason text,
  updated_at timestamptz not null default now()
);

insert into public.multi_spot_paper_accounts (symbol)
values ('SOLUSDT'), ('ETHUSDT'), ('BTCUSDT')
on conflict (symbol) do nothing;

create table if not exists public.multi_spot_paper_positions (
  symbol text primary key references public.multi_spot_paper_accounts(symbol) on delete cascade,
  position_id uuid not null unique,
  quantity numeric(30,12) not null check (quantity > 0),
  entry_fill_price numeric(30,12) not null check (entry_fill_price > 0),
  quote_spent_usdt numeric(20,6) not null check (quote_spent_usdt > 0),
  entry_fee_usdt numeric(20,6) not null default 0,
  stop_loss_price numeric(30,12) not null,
  take_profit_price numeric(30,12) not null,
  trailing_activation_price numeric(30,12) not null,
  trailing_floor_price numeric(30,12),
  highest_price_seen numeric(30,12) not null,
  opened_at timestamptz not null,
  last_checked_at timestamptz not null,
  signal_snapshot jsonb not null default '{}'::jsonb
);

create table if not exists public.multi_spot_paper_trades (
  id bigint generated always as identity primary key,
  position_id uuid not null,
  symbol text not null,
  quantity numeric(30,12) not null,
  entry_fill_price numeric(30,12) not null,
  exit_fill_price numeric(30,12) not null,
  quote_spent_usdt numeric(20,6) not null,
  proceeds_usdt numeric(20,6) not null,
  net_pnl_usdt numeric(20,6) not null,
  net_return_pct numeric(20,8) not null,
  exit_reason text not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  signal_snapshot jsonb not null default '{}'::jsonb,
  exit_snapshot jsonb not null default '{}'::jsonb
);
create index if not exists multi_spot_trades_symbol_closed_idx on public.multi_spot_paper_trades(symbol, closed_at desc);

create table if not exists public.multi_spot_paper_scan_runs (
  id bigint generated always as identity primary key,
  symbol text not null,
  candle_close_time timestamptz not null,
  close_price numeric(30,12) not null,
  score integer,
  threshold integer,
  passed boolean not null default false,
  action text not null,
  reasons text[] not null default '{}',
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(symbol, candle_close_time)
);

create table if not exists public.multi_spot_paper_worker_state (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  worker_id text,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
insert into public.multi_spot_paper_worker_state(id) values(1) on conflict(id) do nothing;

alter table public.multi_spot_paper_accounts enable row level security;
alter table public.multi_spot_paper_positions enable row level security;
alter table public.multi_spot_paper_trades enable row level security;
alter table public.multi_spot_paper_scan_runs enable row level security;
alter table public.multi_spot_paper_worker_state enable row level security;
revoke all on public.multi_spot_paper_accounts, public.multi_spot_paper_positions, public.multi_spot_paper_trades, public.multi_spot_paper_scan_runs, public.multi_spot_paper_worker_state from anon, authenticated;

create or replace function public.multi_spot_claim_worker(p_worker_id text, p_lease_seconds integer default 45)
returns boolean language plpgsql security definer set search_path=public as $$
declare claimed boolean;
begin
  update public.multi_spot_paper_worker_state
  set worker_id=p_worker_id,
      lease_expires_at=now()+make_interval(secs=>greatest(20,least(300,p_lease_seconds))),
      last_heartbeat_at=now(), updated_at=now()
  where id=1 and (worker_id is null or worker_id=p_worker_id or lease_expires_at is null or lease_expires_at<now());
  get diagnostics claimed=row_count;
  return claimed;
end; $$;
revoke all on function public.multi_spot_claim_worker(text,integer) from public,anon,authenticated;
grant execute on function public.multi_spot_claim_worker(text,integer) to service_role;
