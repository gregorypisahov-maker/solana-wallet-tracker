create table if not exists public.lp_onchain_resolutions (
  pool text primary key,
  mint text not null,
  dex_id text,
  pool_program text,
  lp_mint text,
  verdict text not null check (verdict in ('LOCKED','BURNED','CURVE','UNLOCKED','UNKNOWN')),
  method text not null,
  pct_safe numeric,
  unlock_at timestamptz,
  excluded_accounts text[] not null default '{}',
  details jsonb not null default '{}',
  resolved_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists lp_onchain_resolutions_mint_idx on public.lp_onchain_resolutions(mint);
alter table public.lp_onchain_resolutions enable row level security;

create table if not exists public.token_control_resolutions (
  mint text primary key,
  token_program text not null,
  safe boolean not null,
  reason text,
  details jsonb not null default '{}',
  resolved_at timestamptz not null default now()
);
alter table public.token_control_resolutions enable row level security;

comment on table public.lp_onchain_resolutions is 'Server-only cached on-chain LP/curve safety verdicts; hard-live gate evidence.';
comment on table public.token_control_resolutions is 'Server-only cached SPL/Token-2022 control resolution evidence.';
