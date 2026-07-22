create index if not exists wallet_transactions_created_at_id_idx
  on public.wallet_transactions(created_at asc, id asc);

create table if not exists public.shadow_wallet_quality (
  wallet_address text primary key references public.wallets(address) on delete cascade,
  profile_version integer not null default 1,
  lookback_days integer not null default 14,
  observed_swaps integer not null default 0,
  return_count integer not null default 0,
  mean_return numeric,
  return_sd numeric,
  t_stat numeric,
  recent_1 numeric,
  recent_1_5 numeric,
  recent_6_10 numeric,
  recent_11_15 numeric,
  returns jsonb not null default '[]'::jsonb,
  passed boolean not null default false,
  decision_reasons text[] not null default '{}',
  error_message text,
  profiled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shadow_wallet_quality_profiled_idx
  on public.shadow_wallet_quality(profiled_at desc);

create table if not exists public.shadow_coin_quality (
  mint text primary key,
  creator_wallet text,
  creation_block bigint,
  same_block_buyer_count integer,
  first_five_block_buyer_count integer,
  bundle_detected boolean,
  sniper_detected boolean,
  passed boolean not null default false,
  decision_reasons text[] not null default '{}',
  error_message text,
  source text not null default 'helius_getTransactionsForAddress',
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shadow_coin_quality_fetched_idx
  on public.shadow_coin_quality(fetched_at desc);

alter table public.shadow_wallet_quality enable row level security;
alter table public.shadow_coin_quality enable row level security;

comment on table public.shadow_wallet_quality is
  'Shadow-only realized wallet-return significance and multi-horizon decay cache.';
comment on table public.shadow_coin_quality is
  'Shadow-only token launch-block bundle and early sniper assessment cache.';
