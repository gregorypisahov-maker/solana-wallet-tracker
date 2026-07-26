begin;

create table if not exists public.live_trade_signals (
  id uuid primary key,
  strategy text not null,
  source_position_id text not null,
  mint text not null,
  token_symbol text,
  side text not null check (side in ('buy','sell')),
  requested_size_sol numeric,
  requested_token_amount text,
  max_slippage_bps integer not null default 100 check (max_slippage_bps between 10 and 200),
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
  requested_token_amount text,
  quoted_input_amount text,
  quoted_output_amount text,
  actual_input_amount text,
  actual_output_amount text,
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
  source_position_id text not null,
  mint text not null,
  token_symbol text,
  entry_order_id uuid not null references public.live_orders(id),
  entry_tx_signature text not null,
  token_amount text not null,
  spent_sol numeric not null,
  exit_order_id uuid references public.live_orders(id),
  exit_tx_signature text,
  proceeds_sol numeric,
  realized_pnl_sol numeric,
  status text not null default 'open' check (status in ('open','closing','closed','reconciliation_required')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(strategy, source_position_id)
);

create table if not exists public.live_executor_state (
  id integer primary key check (id = 1),
  enabled boolean not null default false,
  halted boolean not null default true,
  halt_reason text not null default 'not_armed',
  max_position_sol numeric not null default 0.02 check (max_position_sol > 0 and max_position_sol <= 0.10),
  max_open_positions integer not null default 1 check (max_open_positions = 1),
  max_daily_entries integer not null default 2 check (max_daily_entries between 1 and 5),
  max_daily_loss_sol numeric not null default 0.02 check (max_daily_loss_sol > 0 and max_daily_loss_sol <= 0.10),
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
create unique index if not exists live_one_active_position_per_mint_idx
  on public.live_positions(strategy, mint)
  where status in ('open','closing','reconciliation_required');

alter table public.live_trade_signals enable row level security;
alter table public.live_orders enable row level security;
alter table public.live_positions enable row level security;
alter table public.live_executor_state enable row level security;

commit;
