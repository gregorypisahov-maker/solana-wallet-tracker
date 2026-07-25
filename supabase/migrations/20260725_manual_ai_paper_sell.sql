-- Atomic manual close for the AI Discovery paper trade and its 5x AI Capital mirror.
-- This only updates paper-accounting tables. It cannot sign or submit a blockchain transaction.

create unique index if not exists ai_discovery_trades_position_uidx
  on public.ai_discovery_trades (position_id);

create or replace function public.manual_close_ai_paper_positions(
  p_exit_price_usd numeric,
  p_market_snapshot jsonb default '{}'::jsonb,
  p_closed_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_pos public.ai_discovery_positions%rowtype;
  v_source_state public.ai_discovery_state%rowtype;
  v_capital_pos public.ai_capital_positions%rowtype;
  v_capital_state public.ai_capital_state%rowtype;
  v_source_trade_id bigint;
  v_capital_trade_id bigint;
  v_gross_pct numeric;
  v_net_pct numeric;
  v_source_pnl numeric;
  v_source_proceeds numeric;
  v_source_losses integer;
  v_capital_pnl numeric := null;
  v_capital_proceeds numeric := null;
  v_capital_losses integer;
  v_capital_daily_pnl numeric;
  v_capital_should_halt boolean;
  v_capital_closed boolean := false;
begin
  if p_exit_price_usd is null or p_exit_price_usd <= 0 then
    raise exception 'exit price must be greater than zero' using errcode = '22023';
  end if;

  select *
    into v_source_pos
    from public.ai_discovery_positions
    order by opened_at asc
    limit 1
    for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_open_position');
  end if;

  select *
    into v_source_state
    from public.ai_discovery_state
    where id = 1
    for update;

  v_gross_pct := ((p_exit_price_usd / v_source_pos.entry_price_usd) - 1) * 100;
  v_net_pct := v_gross_pct - 1.2;
  v_source_pnl := v_source_pos.size_sol * v_net_pct / 100;
  v_source_proceeds := greatest(0, v_source_pos.size_sol + v_source_pnl);

  insert into public.ai_discovery_trades (
    position_id, mint, token_symbol, pair_address,
    entry_price_usd, exit_price_usd, size_sol,
    gross_return_pct, net_return_pct, pnl_sol, exit_reason,
    opened_at, closed_at, entry_snapshot, exit_snapshot
  ) values (
    v_source_pos.position_id, v_source_pos.mint, v_source_pos.token_symbol, v_source_pos.pair_address,
    v_source_pos.entry_price_usd, p_exit_price_usd, v_source_pos.size_sol,
    v_gross_pct, v_net_pct, v_source_pnl, 'manual_sell',
    v_source_pos.opened_at, p_closed_at, v_source_pos.entry_snapshot,
    jsonb_build_object(
      'version', 'manual_ai_paper_sell_v1_2026_07_25',
      'market', coalesce(p_market_snapshot, '{}'::jsonb),
      'peakPriceUsd', v_source_pos.peak_price_usd,
      'requestedBy', 'dashboard'
    )
  )
  on conflict (position_id) do nothing
  returning id into v_source_trade_id;

  if v_source_trade_id is null then
    return jsonb_build_object('ok', false, 'error', 'already_closed');
  end if;

  delete from public.ai_discovery_positions
   where position_id = v_source_pos.position_id;

  v_source_losses := case
    when v_source_pnl < 0 then v_source_state.consecutive_losses + 1
    else 0
  end;

  update public.ai_discovery_state
     set bankroll_sol = v_source_state.bankroll_sol + v_source_proceeds,
         daily_realized_pnl_sol = v_source_state.daily_realized_pnl_sol + v_source_pnl,
         consecutive_losses = v_source_losses,
         updated_at = p_closed_at
   where id = 1;

  select *
    into v_capital_pos
    from public.ai_capital_positions
    where source_position_id = v_source_pos.position_id
    for update;

  if found then
    select *
      into v_capital_state
      from public.ai_capital_state
      where id = 1
      for update;

    v_capital_pnl := v_capital_pos.size_sol * v_net_pct / 100;
    v_capital_proceeds := greatest(0, v_capital_pos.size_sol + v_capital_pnl);

    insert into public.ai_capital_trades (
      position_id, source_position_id, mint, token_symbol, pair_address,
      entry_price_usd, exit_price_usd, size_sol,
      gross_return_pct, net_return_pct, pnl_sol, exit_reason,
      opened_at, closed_at, source_trade_id, entry_snapshot, exit_snapshot
    ) values (
      v_capital_pos.position_id, v_capital_pos.source_position_id,
      v_capital_pos.mint, v_capital_pos.token_symbol, v_capital_pos.pair_address,
      v_capital_pos.entry_price_usd, p_exit_price_usd, v_capital_pos.size_sol,
      v_gross_pct, v_net_pct, v_capital_pnl, 'manual_sell',
      v_capital_pos.opened_at, p_closed_at, v_source_trade_id,
      v_capital_pos.entry_snapshot,
      jsonb_build_object(
        'version', 'manual_ai_paper_sell_v1_2026_07_25',
        'market', coalesce(p_market_snapshot, '{}'::jsonb),
        'sourceTradeId', v_source_trade_id,
        'requestedBy', 'dashboard'
      )
    )
    on conflict (position_id) do nothing
    returning id into v_capital_trade_id;

    if v_capital_trade_id is not null then
      delete from public.ai_capital_positions
       where position_id = v_capital_pos.position_id;

      v_capital_losses := case
        when v_capital_pnl < 0 then v_capital_state.consecutive_losses + 1
        else 0
      end;
      v_capital_daily_pnl := v_capital_state.daily_realized_pnl_sol + v_capital_pnl;
      v_capital_should_halt := v_capital_daily_pnl <= -0.25 or v_capital_losses >= 3;

      update public.ai_capital_state
         set bankroll_sol = v_capital_state.bankroll_sol + v_capital_proceeds,
             daily_realized_pnl_sol = v_capital_daily_pnl,
             consecutive_losses = v_capital_losses,
             halted = v_capital_state.halted or v_capital_should_halt,
             halt_reason = case
               when v_capital_state.halted then v_capital_state.halt_reason
               when v_capital_daily_pnl <= -0.25 then 'daily_loss_limit'
               when v_capital_losses >= 3 then 'consecutive_loss_limit'
               else v_capital_state.halt_reason
             end,
             last_sync_at = p_closed_at,
             updated_at = p_closed_at
       where id = 1;

      v_capital_closed := true;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'tokenSymbol', v_source_pos.token_symbol,
    'sourcePositionId', v_source_pos.position_id,
    'sourceTradeId', v_source_trade_id,
    'exitPriceUsd', p_exit_price_usd,
    'grossReturnPct', v_gross_pct,
    'netReturnPct', v_net_pct,
    'sourcePnlSol', v_source_pnl,
    'capitalClosed', v_capital_closed,
    'capitalPnlSol', v_capital_pnl
  );
end;
$$;

revoke all on function public.manual_close_ai_paper_positions(numeric, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.manual_close_ai_paper_positions(numeric, jsonb, timestamptz)
  to service_role;
