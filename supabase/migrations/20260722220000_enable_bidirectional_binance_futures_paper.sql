alter table public.binance_futures_positions
  drop constraint if exists binance_futures_positions_side_check;
alter table public.binance_futures_positions
  add constraint binance_futures_positions_side_check
  check (side in ('SHORT','LONG'));

alter table public.binance_futures_trades
  drop constraint if exists binance_futures_trades_side_check;
alter table public.binance_futures_trades
  add constraint binance_futures_trades_side_check
  check (side in ('SHORT','LONG'));

create or replace function public.binance_futures_open_paper_position_v2(
  p_position_id text,
  p_symbol text,
  p_side text,
  p_leverage integer,
  p_requested_margin_usdt numeric,
  p_margin_usdt numeric,
  p_notional_usdt numeric,
  p_quantity numeric,
  p_signal_price numeric,
  p_entry_fill_price numeric,
  p_stop_loss_price numeric,
  p_take_profit_price numeric,
  p_entry_fee_usdt numeric,
  p_opened_at timestamptz,
  p_signal_snapshot jsonb,
  p_max_daily_entries integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.binance_futures_state%rowtype;
  v_today date := (p_opened_at at time zone 'UTC')::date;
  v_side text := upper(trim(p_side));
begin
  if v_side not in ('SHORT','LONG') then
    raise exception 'invalid binance futures side: %', p_side;
  end if;

  select * into v_state
  from public.binance_futures_state
  where id = 1
  for update;

  if not found then
    raise exception 'binance futures state is missing';
  end if;

  if v_state.daily_date <> v_today then
    update public.binance_futures_state
    set daily_date = v_today,
        daily_realized_pnl_usdt = 0,
        entries_today = 0,
        consecutive_losses = 0,
        halted = false,
        halt_reason = null,
        updated_at = now()
    where id = 1
    returning * into v_state;
  end if;

  if not v_state.enabled then
    raise exception 'binance futures paper bot is disabled';
  end if;
  if v_state.halted then
    raise exception 'binance futures paper bot is halted: %', coalesce(v_state.halt_reason, 'risk guard');
  end if;
  if v_state.cooldown_until is not null and v_state.cooldown_until > p_opened_at then
    raise exception 'binance futures paper bot is in cooldown';
  end if;
  if v_state.entries_today >= p_max_daily_entries then
    raise exception 'binance futures daily entry limit reached';
  end if;
  if exists (select 1 from public.binance_futures_positions) then
    raise exception 'a binance futures paper position is already open';
  end if;
  if v_state.bankroll_usdt < p_margin_usdt + p_entry_fee_usdt then
    raise exception 'insufficient binance futures paper bankroll';
  end if;

  insert into public.binance_futures_positions (
    position_id, symbol, side, leverage,
    requested_margin_usdt, margin_usdt, notional_usdt, quantity,
    signal_price, entry_fill_price, stop_loss_price, take_profit_price,
    entry_fee_usdt, lowest_price_seen, highest_price_seen, last_market_price,
    opened_at, last_checked_at, signal_snapshot
  ) values (
    p_position_id, upper(p_symbol), v_side, p_leverage,
    p_requested_margin_usdt, p_margin_usdt, p_notional_usdt, p_quantity,
    p_signal_price, p_entry_fill_price, p_stop_loss_price, p_take_profit_price,
    p_entry_fee_usdt, p_entry_fill_price, p_entry_fill_price, p_entry_fill_price,
    p_opened_at, p_opened_at, coalesce(p_signal_snapshot, '{}'::jsonb)
  );

  update public.binance_futures_state
  set bankroll_usdt = bankroll_usdt - p_margin_usdt - p_entry_fee_usdt,
      entries_today = entries_today + 1,
      last_signal_at = p_opened_at,
      last_entry_at = p_opened_at,
      updated_at = now()
  where id = 1
  returning * into v_state;

  return jsonb_build_object(
    'bankrollUsdt', v_state.bankroll_usdt,
    'entriesToday', v_state.entries_today,
    'side', v_side
  );
end;
$$;

revoke all on function public.binance_futures_open_paper_position_v2(
  text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz,jsonb,integer
) from public, anon, authenticated;
