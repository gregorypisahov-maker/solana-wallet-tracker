alter table public.binance_futures_state
  add column if not exists short_cooldown_until timestamptz,
  add column if not exists long_cooldown_until timestamptz;

alter table public.binance_futures_positions
  drop constraint if exists binance_futures_positions_symbol_key;

drop index if exists public.binance_futures_positions_symbol_side_key;
create unique index binance_futures_positions_symbol_side_key
  on public.binance_futures_positions (symbol, side);

create or replace function public.binance_futures_open_paper_position_v3(
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
  v_side_cooldown timestamptz;
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

  v_side_cooldown := case
    when v_side = 'SHORT' then v_state.short_cooldown_until
    else v_state.long_cooldown_until
  end;
  if v_side_cooldown is not null and v_side_cooldown > p_opened_at then
    raise exception 'binance futures % slot is in cooldown', v_side;
  end if;

  if v_state.entries_today >= p_max_daily_entries then
    raise exception 'binance futures daily entry limit reached';
  end if;
  if exists (
    select 1
    from public.binance_futures_positions
    where symbol = upper(p_symbol)
      and side = v_side
  ) then
    raise exception 'a binance futures % paper position is already open', v_side;
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

create or replace function public.binance_futures_close_paper_position(
  p_position_id text,
  p_exit_market_price numeric,
  p_exit_fill_price numeric,
  p_exit_fee_usdt numeric,
  p_gross_pnl_usdt numeric,
  p_net_pnl_usdt numeric,
  p_price_return_pct numeric,
  p_margin_return_pct numeric,
  p_exit_reason text,
  p_closed_at timestamptz,
  p_cooldown_until timestamptz,
  p_exit_snapshot jsonb,
  p_daily_loss_limit_usdt numeric,
  p_max_consecutive_losses integer,
  p_max_daily_entries integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position public.binance_futures_positions%rowtype;
  v_state public.binance_futures_state%rowtype;
  v_daily_pnl numeric;
  v_losses integer;
  v_halted boolean;
  v_halt_reason text;
begin
  if p_exit_reason not in ('take_profit', 'stop_loss', 'max_hold_time', 'manual_close') then
    raise exception 'invalid binance futures exit reason';
  end if;

  select * into v_state
  from public.binance_futures_state
  where id = 1
  for update;

  select * into v_position
  from public.binance_futures_positions
  where position_id = p_position_id
  for update;

  if not found then
    raise exception 'binance futures paper position not found';
  end if;

  v_daily_pnl := v_state.daily_realized_pnl_usdt + p_net_pnl_usdt;
  v_losses := case when p_net_pnl_usdt < 0 then v_state.consecutive_losses + 1 else 0 end;
  v_halted := v_state.halted;
  v_halt_reason := v_state.halt_reason;

  if v_daily_pnl <= -abs(p_daily_loss_limit_usdt) then
    v_halted := true;
    v_halt_reason := 'daily_loss_limit';
  elsif v_losses >= p_max_consecutive_losses then
    v_halted := true;
    v_halt_reason := 'consecutive_loss_limit';
  elsif v_state.entries_today >= p_max_daily_entries then
    v_halted := true;
    v_halt_reason := 'daily_entry_limit';
  end if;

  insert into public.binance_futures_trades (
    position_id, symbol, side, leverage,
    requested_margin_usdt, margin_usdt, notional_usdt, quantity,
    signal_price, entry_fill_price, exit_market_price, exit_fill_price,
    stop_loss_price, take_profit_price,
    entry_fee_usdt, exit_fee_usdt, gross_pnl_usdt, net_pnl_usdt,
    price_return_pct, margin_return_pct,
    lowest_price_seen, highest_price_seen,
    exit_reason, opened_at, closed_at,
    signal_snapshot, exit_snapshot
  ) values (
    v_position.position_id, v_position.symbol, v_position.side, v_position.leverage,
    v_position.requested_margin_usdt, v_position.margin_usdt, v_position.notional_usdt, v_position.quantity,
    v_position.signal_price, v_position.entry_fill_price, p_exit_market_price, p_exit_fill_price,
    v_position.stop_loss_price, v_position.take_profit_price,
    v_position.entry_fee_usdt, p_exit_fee_usdt, p_gross_pnl_usdt, p_net_pnl_usdt,
    p_price_return_pct, p_margin_return_pct,
    v_position.lowest_price_seen, v_position.highest_price_seen,
    p_exit_reason, v_position.opened_at, p_closed_at,
    v_position.signal_snapshot, coalesce(p_exit_snapshot, '{}'::jsonb)
  );

  delete from public.binance_futures_positions
  where position_id = p_position_id;

  update public.binance_futures_state
  set bankroll_usdt = bankroll_usdt + v_position.margin_usdt + p_gross_pnl_usdt - p_exit_fee_usdt,
      realized_pnl_usdt = realized_pnl_usdt + p_net_pnl_usdt,
      daily_realized_pnl_usdt = v_daily_pnl,
      consecutive_losses = v_losses,
      halted = v_halted,
      halt_reason = v_halt_reason,
      last_exit_at = p_closed_at,
      short_cooldown_until = case
        when v_position.side = 'SHORT' then p_cooldown_until
        else short_cooldown_until
      end,
      long_cooldown_until = case
        when v_position.side = 'LONG' then p_cooldown_until
        else long_cooldown_until
      end,
      cooldown_until = case
        when v_position.side = 'SHORT' then greatest(p_cooldown_until, coalesce(long_cooldown_until, p_cooldown_until))
        else greatest(p_cooldown_until, coalesce(short_cooldown_until, p_cooldown_until))
      end,
      last_market_price = p_exit_market_price,
      updated_at = now()
  where id = 1
  returning * into v_state;

  return jsonb_build_object(
    'bankrollUsdt', v_state.bankroll_usdt,
    'realizedPnlUsdt', v_state.realized_pnl_usdt,
    'dailyRealizedPnlUsdt', v_state.daily_realized_pnl_usdt,
    'halted', v_state.halted,
    'haltReason', v_state.halt_reason,
    'consecutiveLosses', v_state.consecutive_losses,
    'closedSide', v_position.side
  );
end;
$$;

revoke all on function public.binance_futures_open_paper_position_v3(
  text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz,jsonb,integer
) from public, anon, authenticated;
grant execute on function public.binance_futures_open_paper_position_v3(
  text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz,jsonb,integer
) to service_role;

revoke all on function public.binance_futures_close_paper_position(
  text, numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  text, timestamptz, timestamptz, jsonb, numeric, integer, integer
) from public, anon, authenticated;
grant execute on function public.binance_futures_close_paper_position(
  text, numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  text, timestamptz, timestamptz, jsonb, numeric, integer, integer
) to service_role;
