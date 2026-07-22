alter table public.binance_futures_state
  add column if not exists connection_status text not null default 'starting',
  add column if not exists data_source text,
  add column if not exists last_error text;

alter table public.binance_futures_state
  drop constraint if exists binance_futures_state_connection_status_check;

alter table public.binance_futures_state
  add constraint binance_futures_state_connection_status_check
  check (connection_status in ('starting', 'connected', 'degraded', 'error', 'disabled'));

revoke all on public.binance_futures_state from public, anon, authenticated;
