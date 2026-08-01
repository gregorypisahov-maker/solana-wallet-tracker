create or replace function public.emit_ai_discovery_live_sell_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  live_enabled boolean;
  has_open_live_position boolean;
begin
  select enabled into live_enabled
  from public.live_executor_state
  where id = 1;

  select exists (
    select 1
    from public.live_positions
    where source_position_id = new.position_id
      and status = 'open'
  ) into has_open_live_position;

  if coalesce(live_enabled, false) and coalesce(has_open_live_position, false) then
    insert into public.live_trade_signals (
      id, strategy, source_position_id, mint, token_symbol, side,
      requested_token_amount, max_slippage_bps, status, metadata, created_at
    ) values (
      gen_random_uuid(), 'ai_discovery', new.position_id, new.mint, new.token_symbol, 'sell',
      null, 100, 'pending',
      jsonb_build_object(
        'source', 'ai_discovery_decision_trigger',
        'decision_at', new.closed_at,
        'exit_reason', new.exit_reason,
        'paper_exit_price_usd', new.exit_price_usd,
        'pair_address', new.pair_address
      ),
      new.closed_at
    )
    on conflict (strategy, source_position_id, side) do nothing;
  end if;

  return new;
end;
$$;

update public.live_trade_signals s
set status = 'rejected',
    rejection_reason = 'paper_only_position_skipped',
    completed_at = coalesce(completed_at, now()),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('skip_reason', 'no_open_live_position')
where s.side = 'sell'
  and s.status in ('pending','claimed')
  and not exists (
    select 1
    from public.live_positions p
    where p.source_position_id = s.source_position_id
      and p.status = 'open'
  );
