create table if not exists public.buyer_flow_snapshots (
  id bigint generated always as identity primary key,
  mint text not null,
  pair_address text,
  token_symbol text,
  observed_at timestamptz not null default now(),
  market_cap_usd numeric,
  liquidity_usd numeric,
  unique_buyers_5m integer,
  buys_5m integer not null default 0,
  sells_5m integer not null default 0,
  buyers_per_min numeric,
  buyer_delta integer,
  buyer_delta_delta integer,
  buyer_acceleration_pct numeric,
  snapshot jsonb not null default '{}'::jsonb
);

create index if not exists buyer_flow_snapshots_mint_time_idx
  on public.buyer_flow_snapshots (mint, observed_at desc);

create table if not exists public.buyer_acceleration_alerts (
  id bigint generated always as identity primary key,
  mint text not null,
  token_symbol text,
  pair_address text,
  alerted_at timestamptz not null default now(),
  market_cap_usd numeric,
  liquidity_usd numeric,
  unique_buyers_5m integer,
  buyer_delta integer,
  buyer_delta_delta integer,
  buyer_acceleration_pct numeric,
  message text not null
);

create index if not exists buyer_acceleration_alerts_mint_time_idx
  on public.buyer_acceleration_alerts (mint, alerted_at desc);

alter table public.buyer_flow_snapshots enable row level security;
alter table public.buyer_acceleration_alerts enable row level security;

revoke all on public.buyer_flow_snapshots from anon, authenticated;
revoke all on public.buyer_acceleration_alerts from anon, authenticated;
