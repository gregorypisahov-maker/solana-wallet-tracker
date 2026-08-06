begin;

create table if not exists public.jijo_copy_state (
  id smallint primary key check (id = 1),
  version text not null default 'jijo_copy_v1_2026_08_06',
  target_wallet text not null default '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk',
  enabled boolean not null default false,
  execution_mode text not null default 'live' check (execution_mode in ('observe','live')),
  halted boolean not null default true,
  halt_reason text not null default 'not_armed',
  copy_ratio numeric not null default 0.001 check (copy_ratio > 0 and copy_ratio <= 1),
  max_position_sol numeric not null default 0.02 check (max_position_sol > 0 and max_position_sol <= 0.10),
  max_open_positions integer not null default 1 check (max_open_positions between 1 and 5),
  max_daily_entries integer not null default 5 check (max_daily_entries between 1 and 30),
  max_daily_loss_sol numeric not null default 0.02 check (max_daily_loss_sol > 0 and max_daily_loss_sol <= 0.20),
  max_slippage_bps integer not null default 150 check (max_slippage_bps between 10 and 200),
  min_wallet_reserve_sol numeric not null default 0.05 check (min_wallet_reserve_sol >= 0.02),
  max_source_age_ms integer not null default 30000 check (max_source_age_ms between 3000 and 120000),
  last_signature text,
  last_seen_at timestamptz,
  last_heartbeat_at timestamptz,
  executing boolean not null default false,
  active_event_id uuid,
  daily_date date not null default current_date,
  daily_entries integer not null default 0,
  daily_realized_pnl_sol numeric not null default 0,
  signer_verified_events bigint not null default 0,
  ignored_events bigint not null default 0,
  blocked_events bigint not null default 0,
  confirmed_buys bigint not null default 0,
  confirmed_sells bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.jijo_copy_state (id) values (1)
on conflict (id) do nothing;

create table if not exists public.jijo_copy_events (
  id uuid primary key,
  signature text not null,
  slot bigint,
  block_time timestamptz,
  detected_at timestamptz not null default now(),
  signer_verified boolean not null default false,
  mint text not null,
  token_symbol text,
  side text not null check (side in ('buy','sell')),
  target_sol_delta numeric not null default 0,
  target_token_delta text not null,
  target_token_pre_amount text,
  target_token_post_amount text,
  target_sell_fraction numeric,
  source_age_ms integer,
  status text not null default 'detected'
    check (status in ('detected','observed','ignored','blocked','submitted','confirmed','failed')),
  reason text,
  our_requested_sol numeric,
  our_requested_token_amount text,
  our_actual_sol_delta numeric,
  our_actual_token_delta text,
  our_tx_signature text,
  realized_pnl_sol numeric,
  safety_snapshot jsonb not null default '{}'::jsonb,
  raw_summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique(signature, mint, side)
);

create table if not exists public.jijo_copy_positions (
  id uuid primary key,
  mint text not null,
  token_symbol text,
  token_amount text not null,
  spent_sol numeric not null,
  realized_pnl_sol numeric not null default 0,
  target_entry_signature text,
  entry_tx_signature text,
  last_target_signature text,
  last_copy_tx_signature text,
  status text not null default 'open'
    check (status in ('open','closing','closed','reconciliation_required')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists jijo_copy_one_open_position_per_mint_idx
  on public.jijo_copy_positions(mint)
  where status in ('open','closing','reconciliation_required');

create index if not exists jijo_copy_events_recent_idx
  on public.jijo_copy_events(detected_at desc);

create index if not exists jijo_copy_events_status_idx
  on public.jijo_copy_events(status, detected_at desc);

create index if not exists jijo_copy_positions_status_idx
  on public.jijo_copy_positions(status, opened_at desc);

alter table public.jijo_copy_state enable row level security;
alter table public.jijo_copy_events enable row level security;
alter table public.jijo_copy_positions enable row level security;

commit;
