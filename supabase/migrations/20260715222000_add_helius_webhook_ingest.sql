alter table public.monitor_usage_samples
  add column if not exists webhook_events integer not null default 0
    check (webhook_events >= 0),
  add column if not exists mode text not null default 'websocket'
    check (mode in ('websocket', 'webhook'));

create index if not exists wallet_transactions_scalp_lookup_idx
  on public.wallet_transactions (wallet_address, token_mint, side, tx_time);

create or replace function public.ingest_wallet_trade(
  p_wallet_address text,
  p_signature text,
  p_token_mint text,
  p_side text,
  p_sol_amount numeric,
  p_token_amount numeric,
  p_tx_time timestamptz,
  p_scalp_window_minutes integer default 5
)
returns table(inserted boolean, is_scalp boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opposite_side text;
  v_is_scalp boolean;
  v_rows integer;
begin
  if p_side not in ('buy', 'sell') then
    raise exception 'invalid trade side';
  end if;

  -- Serialize opposite-side detection per wallet/mint so simultaneous webhook
  -- deliveries cannot disagree about scalp status.
  perform pg_advisory_xact_lock(
    hashtextextended(p_wallet_address || ':' || p_token_mint, 0)
  );

  v_opposite_side := case when p_side = 'buy' then 'sell' else 'buy' end;
  select exists (
    select 1
    from public.wallet_transactions
    where wallet_address = p_wallet_address
      and token_mint = p_token_mint
      and side = v_opposite_side
      and tx_time between
        p_tx_time - make_interval(mins => greatest(1, p_scalp_window_minutes))
        and p_tx_time + make_interval(mins => greatest(1, p_scalp_window_minutes))
  ) into v_is_scalp;

  if v_is_scalp then
    update public.wallet_transactions
    set is_scalp = true
    where wallet_address = p_wallet_address
      and token_mint = p_token_mint
      and side = v_opposite_side
      and tx_time between
        p_tx_time - make_interval(mins => greatest(1, p_scalp_window_minutes))
        and p_tx_time + make_interval(mins => greatest(1, p_scalp_window_minutes));
  end if;

  insert into public.wallet_transactions (
    wallet_address,
    signature,
    token_mint,
    side,
    sol_amount,
    token_amount,
    tx_time,
    is_scalp
  ) values (
    p_wallet_address,
    p_signature,
    p_token_mint,
    p_side,
    p_sol_amount,
    p_token_amount,
    p_tx_time,
    v_is_scalp
  )
  on conflict (wallet_address, signature, token_mint, side) do nothing;
  get diagnostics v_rows = row_count;

  return query select v_rows > 0, v_is_scalp;
end;
$$;

create or replace function public.record_helius_webhook_batch(
  p_events integer,
  p_stored_trades integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_started_at timestamptz;
begin
  v_period_started_at := date_trunc('hour', now()) +
    floor(extract(minute from now()) / 15) * interval '15 minutes';

  insert into public.monitor_usage_samples (
    instance_id,
    period_started_at,
    recorded_at,
    webhook_events,
    stored_trades,
    mode
  ) values (
    '00000000-0000-0000-0000-000000000001'::uuid,
    v_period_started_at,
    now(),
    greatest(0, p_events),
    greatest(0, p_stored_trades),
    'webhook'
  )
  on conflict (instance_id, period_started_at) do update
  set recorded_at = now(),
      webhook_events = public.monitor_usage_samples.webhook_events + excluded.webhook_events,
      stored_trades = public.monitor_usage_samples.stored_trades + excluded.stored_trades,
      mode = 'webhook';
end;
$$;

revoke all on function public.ingest_wallet_trade(
  text, text, text, text, numeric, numeric, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.ingest_wallet_trade(
  text, text, text, text, numeric, numeric, timestamptz, integer
) to service_role;

revoke all on function public.record_helius_webhook_batch(integer, integer)
  from public, anon, authenticated;
grant execute on function public.record_helius_webhook_batch(integer, integer)
  to service_role;

comment on function public.ingest_wallet_trade is
  'Server-only idempotent trade ingest with serialized scalp detection.';
comment on function public.record_helius_webhook_batch is
  'Server-only 15-minute Helius webhook usage aggregation.';
