create or replace function public.emit_ai_discovery_live_buy_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  live_enabled boolean;
  live_halted boolean;
  live_max_position numeric;
begin
  select enabled, halted, max_position_sol
    into live_enabled, live_halted, live_max_position
  from public.live_executor_state
  where id = 1;

  if coalesce(live_enabled, false) and not coalesce(live_halted, false) then
    insert into public.live_trade_signals (
      id, strategy, source_position_id, mint, token_symbol, side,
      requested_size_sol, max_slippage_bps, status, metadata, created_at
    ) values (
      gen_random_uuid(), 'ai_discovery', new.position_id, new.mint, new.token_symbol, 'buy',
      least(new.size_sol, coalesce(live_max_position, new.size_sol)), 100, 'pending',
      jsonb_build_object(
        'source', 'ai_discovery_decision_trigger',
        'decision_at', new.opened_at,
        'source_opened_at', new.opened_at,
        'paper_entry_price_usd', new.entry_price_usd,
        'pair_address', new.pair_address
      ),
      new.opened_at
    )
    on conflict (strategy, source_position_id, side) do nothing;
  end if;

  return new;
end;
$$;
