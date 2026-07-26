begin;

create table if not exists public.live_trade_signals (
  id uuid primary key,
  strategy text not null,
  source_position_id text,
  mint text not null,
  token_symbol text,
  side text not null check (side in ('buy','sell')),
  requested_size_sol numeric,
  requested_token_amount numeric,
  max_slippage_bps integer not null default 100,
  status text not null default 'pending' check (status in ('pending','claimed','executed','rejected','failed','cancelled')),
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  unique(strategy, source_position_id, side)
);

create table if not exists public.live_orders (
  id uuid primary key,
  signal_id uuid not null references public.live_trade_signals(id),
  strategy text not null,
  mint text not null,
  side text not null check (side in ('buy','sell')),
  requested_size_sol numeric,
  quoted_input_amount text,
  quoted_output_amount text,
  max_slippage_bps integer not null,
  status text not null check (status in ('created','submitted','confirmed','failed','rejected')),
  tx_signature text,
  error text,
  quote jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(signal_id)
);

create table if not exists public.live_positions (
  id uuid primary key,
  strategy text not null,
  source_position_id text,
  mint text not null,
  token_symbol text,
  entry_order_id uuid references public.live_orders(id),
  entry_tx_signature text not null,
  token_amount text not null,
  spent_sol numeric not null,
  status text not null default 'open' check (status in ('open','closing','closed','reconciliation_required')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(strategy, source_position_id),
  unique(strategy, mint, status)
);

create table if not exists public.live_executor_state (
  id integer primary key check (id = 1),
  enabled boolean not null default false,
  halted boolean not null default true,
  halt_reason text not null default 'not_armed',
  max_position_sol numeric not null default 0.02,
  max_open_positions integer not null default 1,
  max_daily_entries integer not null default 2,
  max_daily_loss_sol numeric not null default 0.02,
  daily_date date not null default current_date,
  daily_entries integer not null default 0,
  daily_realized_pnl_sol numeric not null default 0,
  last_heartbeat_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.live_executor_state (id) values (1)
on conflict (id) do nothing;

create index if not exists live_trade_signals_pending_idx on public.live_trade_signals(status, created_at);
create index if not exists live_positions_open_idx on public.live_positions(status, opened_at);

commit;
