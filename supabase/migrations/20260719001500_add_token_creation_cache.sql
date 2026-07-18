create table if not exists public.token_creation_cache (
  mint text primary key,
  created_at_chain timestamptz not null,
  fetched_at timestamptz not null default now()
);

comment on table public.token_creation_cache is
  'Immutable token creation timestamps cached for wallet discovery profiling.';
