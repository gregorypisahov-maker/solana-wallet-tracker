-- Run this in the Supabase SQL editor once to set up all tables.

create extension if not exists "uuid-ossp";

-- The 20 (or fewer) wallets you're tracking
create table if not exists wallets (
  id uuid primary key default uuid_generate_v4(),
  address text not null unique,
  label text,
  active boolean not null default true,
  last_signature text,              -- most recent tx signature seen, used as a cursor
  created_at timestamptz not null default now()
);

-- Every buy/sell we detect, one row per wallet-token trade
create table if not exists wallet_transactions (
  id uuid primary key default uuid_generate_v4(),
  wallet_address text not null references wallets(address) on delete cascade,
  signature text not null,
  token_mint text not null,
  token_symbol text,
  side text not null check (side in ('buy', 'sell')),
  sol_amount numeric not null default 0,     -- SOL moved in/out of the wallet for this trade
  token_amount numeric not null default 0,   -- token units moved
  tx_time timestamptz not null,
  is_scalp boolean not null default false,   -- true if matched buy+sell inside SCALP_WINDOW_MINUTES
  created_at timestamptz not null default now(),
  unique (wallet_address, signature, token_mint, side)
);

create index if not exists idx_wallet_tx_token on wallet_transactions(token_mint);
create index if not exists idx_wallet_tx_time on wallet_transactions(tx_time desc);
create index if not exists idx_wallet_tx_wallet on wallet_transactions(wallet_address);

-- Aggregated / scored view per token, recomputed every monitor cycle
create table if not exists token_scores (
  token_mint text primary key,
  token_symbol text,
  token_name text,
  wallets_count int not null default 0,
  total_sol_bought numeric not null default 0,
  first_buy_time timestamptz,
  last_buy_time timestamptz,
  market_cap numeric,
  liquidity_usd numeric,
  holders int,
  holders_prev int,                 -- previous snapshot, used for "holders increasing" scoring
  dump_flag boolean not null default false, -- dev/top holder dumping detected
  scalp_flag boolean not null default false,
  score int not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_token_scores_score on token_scores(score desc);

-- Prevents duplicate Telegram alerts for the same token/window
create table if not exists alerts_sent (
  id uuid primary key default uuid_generate_v4(),
  token_mint text not null,
  wallets_count int not null,
  sent_at timestamptz not null default now()
);

create index if not exists idx_alerts_sent_token on alerts_sent(token_mint, sent_at desc);
