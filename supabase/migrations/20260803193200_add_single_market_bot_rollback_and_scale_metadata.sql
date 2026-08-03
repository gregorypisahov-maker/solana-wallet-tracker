alter table public.single_market_bot_state
  add column if not exists strategy_version text,
  add column if not exists scale_applied_at timestamptz,
  add column if not exists scale_factor numeric,
  add column if not exists scale_source_starting_cash_usdc numeric;

create table if not exists public.single_market_bot_rollbacks (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  label text not null,
  state_snapshot jsonb not null,
  config_snapshot jsonb not null default '{}'::jsonb,
  restored_at timestamptz
);

alter table public.single_market_bot_rollbacks enable row level security;

comment on table public.single_market_bot_rollbacks is 'Server-only snapshots for easy rollback of the isolated single market bot.';
