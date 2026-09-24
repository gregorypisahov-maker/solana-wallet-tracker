begin;

create table if not exists public.trade_research_trades (
  id uuid primary key default uuid_generate_v4(),
  wallet_address text not null,
  token_mint text not null,
  token_symbol text,
  token_name text,
  entry_time timestamptz not null,
  exit_time timestamptz not null,
  hold_seconds bigint not null default 0,
  entry_sol numeric(24,9) not null default 0,
  exit_sol numeric(24,9) not null default 0,
  pnl_sol numeric(24,9) not null default 0,
  roi_pct numeric(24,9),
  entry_price_usd numeric(30,12),
  exit_price_usd numeric(30,12),
  entry_market_cap_usd numeric(30,6),
  exit_market_cap_usd numeric(30,6),
  initial_position_usd numeric(30,6),
  max_drawdown_pct numeric(24,9),
  max_runup_pct numeric(24,9),
  outcome text not null default 'unknown' check (outcome in ('win','loss','flat','unknown')),
  source text not null default 'solana_rpc',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(wallet_address, token_mint, entry_time, exit_time)
);

create index if not exists trade_research_trades_wallet_idx
  on public.trade_research_trades(wallet_address, exit_time desc);
create index if not exists trade_research_trades_outcome_idx
  on public.trade_research_trades(wallet_address, outcome);
create index if not exists trade_research_trades_entry_mc_idx
  on public.trade_research_trades(entry_market_cap_usd);

create table if not exists public.trade_research_social_events (
  id uuid primary key default uuid_generate_v4(),
  trade_id uuid references public.trade_research_trades(id) on delete cascade,
  token_mint text not null,
  event_time timestamptz not null,
  platform text not null,
  creator_handle text,
  creator_url text,
  post_url text,
  follower_count bigint,
  engagement_count bigint,
  narrative_category text,
  narrative_hook text,
  community_traction text,
  evidence text,
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists trade_research_social_token_time_idx
  on public.trade_research_social_events(token_mint, event_time);

create table if not exists public.trade_research_creator_profiles (
  id uuid primary key default uuid_generate_v4(),
  platform text not null,
  handle text not null,
  profile_url text,
  follower_count bigint,
  crypto_relevance text,
  historical_call_count integer,
  historical_win_count integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform, handle)
);

create table if not exists public.trade_research_scans (
  id uuid primary key default uuid_generate_v4(),
  wallet_address text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  signatures_scanned integer not null default 0,
  trades_detected integer not null default 0,
  positions_closed integer not null default 0,
  status text not null default 'running',
  error text
);

alter table public.trade_research_trades enable row level security;
alter table public.trade_research_social_events enable row level security;
alter table public.trade_research_creator_profiles enable row level security;
alter table public.trade_research_scans enable row level security;

revoke all on public.trade_research_trades from anon, authenticated;
revoke all on public.trade_research_social_events from anon, authenticated;
revoke all on public.trade_research_creator_profiles from anon, authenticated;
revoke all on public.trade_research_scans from anon, authenticated;

commit;
