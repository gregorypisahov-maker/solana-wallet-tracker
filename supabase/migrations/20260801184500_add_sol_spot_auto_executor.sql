create table if not exists public.sol_spot_auto_state (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  armed boolean not null default false,
  status text not null default 'disabled',
  halt_reason text,
  wallet_public_key text,
  max_position_usdt numeric(20, 6) not null default 25 check (max_position_usdt between 10 and 200),
  bootstrap_sol_amount numeric(20, 9) not null default 0 check (bootstrap_sol_amount between 0 and 100),
  bootstrap_pending boolean not null default false,
  slippage_bps integer not null default 50 check (slippage_bps between 10 and 200),
  max_daily_loss_usdt numeric(20, 6) not null default 10 check (max_daily_loss_usdt between 1 and 200),
  max_consecutive_losses integer not null default 3 check (max_consecutive_losses between 1 and 10),
  daily_date date not null default current_date,
  daily_entries integer not null default 0,
  daily_realized_pnl_usdt numeric(20, 6) not null default 0,
  realized_pnl_usdt numeric(20, 6) not null default 0,
  consecutive_losses integer not null default 0,
  sol_balance numeric(30, 9),
  usdt_balance numeric(30, 6),
  last_market_price numeric(30, 10),
  last_trade_at timestamptz,
  last_heartbeat_at timestamptz,
  last_error text,
  worker_id text,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.sol_spot_auto_state (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.sol_spot_auto_positions (
  id smallint primary key default 1 check (id = 1),
  position_id uuid not null unique,
  source_paper_position_id uuid,
  quantity_sol numeric(30, 9) not null check (quantity_sol > 0),
  cost_basis_usdt numeric(30, 6) not null check (cost_basis_usdt >= 0),
  entry_price_usdt numeric(30, 10) not null check (entry_price_usdt > 0),
  entry_signature text,
  bootstrap boolean not null default false,
  opened_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sol_spot_auto_orders (
  order_id uuid primary key,
  side text not null check (side in ('buy', 'sell', 'bootstrap_sell')),
  status text not null check (status in ('pending', 'confirmed', 'failed', 'reconciliation_required')),
  source_paper_position_id uuid,
  input_mint text not null,
  output_mint text not null,
  input_amount_atomic text not null,
  output_amount_atomic text,
  signature text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists sol_spot_auto_orders_status_created_idx
  on public.sol_spot_auto_orders (status, created_at desc);

create table if not exists public.sol_spot_auto_trades (
  trade_id uuid primary key,
  position_id uuid not null,
  source_paper_position_id uuid,
  quantity_sol numeric(30, 9) not null,
  cost_usdt numeric(30, 6) not null,
  proceeds_usdt numeric(30, 6) not null,
  pnl_usdt numeric(30, 6) not null,
  return_pct numeric(20, 8) not null,
  entry_signature text,
  exit_signature text not null,
  entry_reason text not null,
  exit_reason text not null,
  bootstrap boolean not null default false,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists sol_spot_auto_trades_closed_idx
  on public.sol_spot_auto_trades (closed_at desc);

alter table public.sol_spot_auto_state enable row level security;
alter table public.sol_spot_auto_positions enable row level security;
alter table public.sol_spot_auto_orders enable row level security;
alter table public.sol_spot_auto_trades enable row level security;

revoke all on public.sol_spot_auto_state from anon, authenticated;
revoke all on public.sol_spot_auto_positions from anon, authenticated;
revoke all on public.sol_spot_auto_orders from anon, authenticated;
revoke all on public.sol_spot_auto_trades from anon, authenticated;

create or replace function public.sol_spot_claim_auto_worker(
  p_worker_id text,
  p_lease_seconds integer default 45
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  update public.sol_spot_auto_state
  set worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(20, least(300, p_lease_seconds))),
      last_heartbeat_at = now(),
      updated_at = now()
  where id = 1
    and (
      worker_id is null
      or worker_id = p_worker_id
      or lease_expires_at is null
      or lease_expires_at < now()
    );

  get diagnostics claimed = row_count;
  return claimed;
end;
$$;

revoke all on function public.sol_spot_claim_auto_worker(text, integer) from public, anon, authenticated;
grant execute on function public.sol_spot_claim_auto_worker(text, integer) to service_role;
