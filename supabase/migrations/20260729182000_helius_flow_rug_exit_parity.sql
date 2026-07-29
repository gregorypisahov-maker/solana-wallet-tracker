alter table public.helius_flow_paper_positions
  add column if not exists quote_fail_streak integer not null default 0,
  add column if not exists first_quote_fail_at timestamptz,
  add column if not exists last_quote_failure text;

create index if not exists helius_flow_positions_symbol_idx
  on public.helius_flow_paper_positions (lower(btrim(coalesce(symbol, ''))));

comment on column public.helius_flow_paper_positions.quote_fail_streak is
  'Consecutive failed or unavailable Jupiter sell quotes. Reaching the configured threshold closes the paper position as a total loss.';
