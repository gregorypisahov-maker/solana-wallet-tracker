-- High-frequency paper position samples for the private AI dashboard live chart.
-- Observability only: this does not change entry, exit, sizing, or wallet behavior.

create table if not exists public.ai_position_price_samples (
  id bigint generated always as identity primary key,
  position_id text not null,
  mint text not null,
  token_symbol text not null,
  pair_address text not null,
  sampled_at timestamptz not null default now(),
  price_usd numeric not null,
  peak_price_usd numeric not null,
  gross_return_pct numeric not null,
  net_return_pct numeric not null,
  trailing_armed boolean not null default false,
  trailing_floor_price_usd numeric,
  source text not null default 'worker'
);

create index if not exists ai_position_samples_position_time_idx
  on public.ai_position_price_samples (position_id, sampled_at asc);

create index if not exists ai_position_samples_sampled_idx
  on public.ai_position_price_samples (sampled_at desc);

alter table public.ai_position_price_samples enable row level security;
revoke all on public.ai_position_price_samples from anon, authenticated;
