alter table public.ai_discovery_positions
  add column if not exists original_size_sol numeric,
  add column if not exists remaining_cost_sol numeric,
  add column if not exists remaining_fraction numeric not null default 1,
  add column if not exists partial_tp_taken boolean not null default false,
  add column if not exists partial_tp_price_usd numeric,
  add column if not exists partial_tp_proceeds_sol numeric not null default 0,
  add column if not exists partial_tp_pnl_sol numeric not null default 0,
  add column if not exists partial_tp_at timestamptz;

update public.ai_discovery_positions
set original_size_sol = coalesce(original_size_sol, size_sol),
    remaining_cost_sol = coalesce(remaining_cost_sol, size_sol),
    remaining_fraction = coalesce(remaining_fraction, 1)
where original_size_sol is null
   or remaining_cost_sol is null;

alter table public.ai_discovery_positions
  drop constraint if exists ai_discovery_positions_remaining_fraction_check;

alter table public.ai_discovery_positions
  add constraint ai_discovery_positions_remaining_fraction_check
  check (remaining_fraction > 0 and remaining_fraction <= 1);

create or replace function public.apply_ai_discovery_partial_tp(
  p_position_id text,
  p_remaining_token_amount text,
  p_partial_price_usd numeric,
  p_partial_proceeds_sol numeric,
  p_partial_pnl_sol numeric,
  p_remaining_cost_sol numeric,
  p_peak_price_usd numeric,
  p_last_executable_value_sol numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_rows integer;
  applied_at timestamptz := now();
begin
  update public.ai_discovery_positions
  set original_size_sol = coalesce(original_size_sol, size_sol),
      remaining_cost_sol = p_remaining_cost_sol,
      remaining_fraction = 0.5,
      partial_tp_taken = true,
      partial_tp_price_usd = p_partial_price_usd,
      partial_tp_proceeds_sol = p_partial_proceeds_sol,
      partial_tp_pnl_sol = p_partial_pnl_sol,
      partial_tp_at = applied_at,
      token_amount = p_remaining_token_amount,
      last_price_usd = p_partial_price_usd,
      peak_price_usd = greatest(coalesce(peak_price_usd, p_peak_price_usd), p_peak_price_usd),
      quote_peak_value_sol = greatest(coalesce(quote_peak_value_sol, 0), p_last_executable_value_sol),
      last_executable_value_sol = p_last_executable_value_sol,
      quote_fail_streak = 0,
      last_checked_at = applied_at,
      entry_snapshot = jsonb_set(
        coalesce(entry_snapshot, '{}'::jsonb),
        '{split_exit}',
        jsonb_build_object(
          'enabled', true,
          'partial_fraction', 0.5,
          'remaining_fraction', 0.5,
          'partial_price_usd', p_partial_price_usd,
          'partial_proceeds_sol', p_partial_proceeds_sol,
          'partial_pnl_sol', p_partial_pnl_sol,
          'partial_taken_at', applied_at,
          'trail_distance_pct', 6
        ),
        true
      ),
      updated_at = applied_at
  where position_id = p_position_id
    and partial_tp_taken = false;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    return false;
  end if;

  update public.ai_discovery_state
  set bankroll_sol = bankroll_sol + p_partial_proceeds_sol,
      daily_realized_pnl_sol = daily_realized_pnl_sol + p_partial_pnl_sol,
      updated_at = applied_at
  where id = 1;

  return true;
end;
$$;

create or replace function public.emit_ai_discovery_live_sell_on_partial_tp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  live_enabled boolean;
begin
  if new.partial_tp_taken and not old.partial_tp_taken then
    select enabled into live_enabled
    from public.live_executor_state
    where id = 1;

    if coalesce(live_enabled, false) then
      insert into public.live_trade_signals (
        id, strategy, source_position_id, mint, token_symbol, side,
        requested_token_amount, max_slippage_bps, status, metadata, created_at
      ) values (
        gen_random_uuid(), 'ai_discovery', new.position_id, new.mint, new.token_symbol, 'sell',
        null, 100, 'pending',
        jsonb_build_object(
          'source', 'paper_split_exit_live_isolation',
          'decision_at', coalesce(new.partial_tp_at, now()),
          'exit_reason', 'paper_partial_take_profit_live_full_exit',
          'paper_partial_fraction', 0.5,
          'paper_partial_price_usd', new.partial_tp_price_usd,
          'pair_address', new.pair_address
        ),
        coalesce(new.partial_tp_at, now())
      )
      on conflict (strategy, source_position_id, side) do nothing;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ai_discovery_partial_tp_emit_live_sell on public.ai_discovery_positions;
create trigger ai_discovery_partial_tp_emit_live_sell
after update of partial_tp_taken on public.ai_discovery_positions
for each row execute function public.emit_ai_discovery_live_sell_on_partial_tp();

comment on column public.ai_discovery_positions.partial_tp_taken is
  'Paper-only split exit flag. Live execution receives a full sell signal at this moment and does not trail the paper remainder.';
