alter table public.ai_discovery_positions
  add column if not exists token_amount text,
  add column if not exists quote_peak_value_sol numeric,
  add column if not exists last_executable_value_sol numeric;

alter table public.ai_discovery_trades
  add column if not exists proceeds_sol numeric,
  add column if not exists execution_source text not null default 'legacy_simulation';

comment on column public.ai_discovery_positions.token_amount is
  'Raw token base units used for read-only Jupiter liquidation quotes.';
comment on column public.ai_discovery_trades.proceeds_sol is
  'Executable SOL proceeds from a Jupiter quote or exact live mirrored fill.';
comment on column public.ai_discovery_trades.execution_source is
  'quote, live_mirror, or legacy_simulation.';

update public.ai_discovery_trades
set proceeds_sol = greatest(0, size_sol + pnl_sol)
where proceeds_sol is null;
