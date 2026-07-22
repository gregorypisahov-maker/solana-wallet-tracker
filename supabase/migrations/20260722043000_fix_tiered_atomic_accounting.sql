alter table public.tiered_state
  add column if not exists daily_date date not null default ((timezone('Asia/Jerusalem', now()))::date),
  add column if not exists entries_today integer not null default 0,
  add column if not exists daily_realized_pnl_sol numeric not null default 0,
  add column if not exists consecutive_hard_stops integer not null default 0;

create or replace function public.tiered_open_position(
  p_mint text,
  p_token_symbol text,
  p_entry_price numeric,
  p_entry_time timestamptz,
  p_size_pct numeric,
  p_entry_alert jsonb,
  p_position_id text,
  p_entry_wallet text,
  p_entry_wallet_trust numeric,
  p_filter_snapshot jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.tiered_state%rowtype;
  v_today date := (timezone('Asia/Jerusalem', now()))::date;
  v_size_sol numeric;
begin
  select * into v_state
  from public.tiered_state
  where id = 1
  for update;

  if not found then
    raise exception 'tiered_state row 1 is missing';
  end if;

  if v_state.daily_date is distinct from v_today then
    update public.tiered_state
    set daily_date = v_today,
        entries_today = 0,
        daily_realized_pnl_sol = 0,
        consecutive_hard_stops = 0,
        halted = case when coalesce(halt_reason, '') like 'circuit_breaker:%' then false else halted end,
        halt_reason = case when coalesce(halt_reason, '') like 'circuit_breaker:%' then null else halt_reason end,
        updated_at = now()
    where id = 1
    returning * into v_state;
  end if;

  if v_state.halted then
    return jsonb_build_object(
      'opened', false,
      'reason', 'halted:' || coalesce(v_state.halt_reason, 'unknown')
    );
  end if;

  if v_state.entries_today >= 12 then
    update public.tiered_state
    set halted = true,
        halt_reason = 'circuit_breaker: maximum 12 daily entries reached',
        updated_at = now()
    where id = 1;
    return jsonb_build_object('opened', false, 'reason', 'daily_entry_limit_reached');
  end if;

  if p_entry_wallet_trust is null or p_entry_wallet_trust < 65 then
    return jsonb_build_object('opened', false, 'reason', 'entry_wallet_trust_below_65');
  end if;

  if p_entry_price is null or p_entry_price <= 0 then
    return jsonb_build_object('opened', false, 'reason', 'invalid_entry_price');
  end if;

  if p_size_pct is null or p_size_pct <= 0 or p_size_pct > 1 then
    return jsonb_build_object('opened', false, 'reason', 'invalid_size_pct');
  end if;

  if (select count(*) from public.tiered_positions) >= 3 then
    return jsonb_build_object('opened', false, 'reason', 'max_concurrent_positions');
  end if;

  if exists (select 1 from public.tiered_positions where mint = p_mint) then
    return jsonb_build_object('opened', false, 'reason', 'mint_already_open');
  end if;

  if exists (
    select 1
    from public.tiered_trades
    where mint = p_mint
      and happened_at >= now() - interval '4 hours'
  ) then
    return jsonb_build_object('opened', false, 'reason', 'mint_in_4h_cooldown');
  end if;

  v_size_sol := v_state.bankroll_sol * p_size_pct;
  if v_size_sol <= 0 or v_size_sol > v_state.bankroll_sol then
    return jsonb_build_object('opened', false, 'reason', 'invalid_position_size');
  end if;

  insert into public.tiered_positions (
    mint,
    token_symbol,
    entry_price,
    entry_time,
    size_sol,
    remaining_pct,
    peak_multiple,
    ladder_hits,
    entry_alert,
    position_id,
    realized_pnl_sol,
    entry_wallet,
    entry_wallet_trust,
    filter_snapshot
  ) values (
    p_mint,
    coalesce(nullif(p_token_symbol, ''), 'UNKNOWN'),
    p_entry_price,
    coalesce(p_entry_time, now()),
    v_size_sol,
    1,
    1,
    '[]'::jsonb,
    coalesce(p_entry_alert, '{}'::jsonb),
    p_position_id,
    0,
    p_entry_wallet,
    p_entry_wallet_trust,
    coalesce(p_filter_snapshot, '{}'::jsonb)
  );

  update public.tiered_state
  set bankroll_sol = bankroll_sol - v_size_sol,
      entries_today = entries_today + 1,
      updated_at = now()
  where id = 1
  returning * into v_state;

  return jsonb_build_object(
    'opened', true,
    'reason', null,
    'position_id', p_position_id,
    'size_sol', v_size_sol,
    'bankroll_sol', v_state.bankroll_sol,
    'entries_today', v_state.entries_today
  );
exception
  when unique_violation then
    return jsonb_build_object('opened', false, 'reason', 'duplicate_position');
end;
$$;

create or replace function public.tiered_apply_exit(
  p_position_id text,
  p_exit_price numeric,
  p_requested_sold_pct numeric,
  p_reason text,
  p_action_terminal boolean,
  p_peak_multiple numeric,
  p_ladder_hits jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.tiered_state%rowtype;
  v_position public.tiered_positions%rowtype;
  v_today date := (timezone('Asia/Jerusalem', now()))::date;
  v_sold_pct numeric;
  v_sold_size_sol numeric;
  v_multiple numeric;
  v_proceeds_sol numeric;
  v_pnl_sol numeric;
  v_remaining_pct numeric;
  v_realized_pnl_sol numeric;
  v_terminal boolean;
  v_daily_pnl numeric;
  v_consecutive_hard_stops integer;
  v_halted boolean;
  v_halt_reason text;
begin
  if p_exit_price is null or p_exit_price <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'invalid_exit_price');
  end if;

  select * into v_state
  from public.tiered_state
  where id = 1
  for update;

  if not found then
    raise exception 'tiered_state row 1 is missing';
  end if;

  if v_state.daily_date is distinct from v_today then
    update public.tiered_state
    set daily_date = v_today,
        entries_today = 0,
        daily_realized_pnl_sol = 0,
        consecutive_hard_stops = 0,
        halted = case when coalesce(halt_reason, '') like 'circuit_breaker:%' then false else halted end,
        halt_reason = case when coalesce(halt_reason, '') like 'circuit_breaker:%' then null else halt_reason end,
        updated_at = now()
    where id = 1
    returning * into v_state;
  end if;

  select * into v_position
  from public.tiered_positions
  where position_id = p_position_id
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'position_not_found');
  end if;

  v_sold_pct := least(
    v_position.remaining_pct,
    greatest(coalesce(p_requested_sold_pct, 0), 0)
  );
  if v_sold_pct <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'nothing_to_sell');
  end if;

  v_sold_size_sol := v_position.size_sol * v_sold_pct;
  v_multiple := p_exit_price / v_position.entry_price;
  v_proceeds_sol := v_sold_size_sol * v_multiple;
  v_pnl_sol := v_proceeds_sol - v_sold_size_sol;
  v_remaining_pct := greatest(0, v_position.remaining_pct - v_sold_pct);
  v_realized_pnl_sol := v_position.realized_pnl_sol + v_pnl_sol;
  v_terminal := coalesce(p_action_terminal, false) or v_remaining_pct <= 0.001;
  v_daily_pnl := v_state.daily_realized_pnl_sol + v_pnl_sol;

  if v_terminal and p_reason = 'hard_stop_loss' then
    v_consecutive_hard_stops := v_state.consecutive_hard_stops + 1;
  elsif v_terminal then
    v_consecutive_hard_stops := 0;
  else
    v_consecutive_hard_stops := v_state.consecutive_hard_stops;
  end if;

  v_halted := v_state.halted;
  v_halt_reason := v_state.halt_reason;
  if not v_state.halted or coalesce(v_state.halt_reason, '') like 'circuit_breaker:%' then
    if v_daily_pnl <= -0.20 then
      v_halted := true;
      v_halt_reason := 'circuit_breaker: daily realized loss reached -0.20 SOL';
    elsif v_consecutive_hard_stops >= 3 then
      v_halted := true;
      v_halt_reason := 'circuit_breaker: 3 consecutive hard stops';
    end if;
  end if;

  insert into public.tiered_trades (
    token_symbol,
    mint,
    type,
    reason,
    entry_price,
    exit_price,
    multiple,
    sold_pct,
    sold_size_sol,
    proceeds_sol,
    pnl_sol,
    hold_minutes,
    happened_at,
    entry_alert,
    position_id,
    entry_wallet
  ) values (
    v_position.token_symbol,
    v_position.mint,
    case when v_terminal then 'sell' else 'partial_sell' end,
    p_reason,
    v_position.entry_price,
    p_exit_price,
    v_multiple,
    v_sold_pct,
    v_sold_size_sol,
    v_proceeds_sol,
    v_pnl_sol,
    extract(epoch from (now() - v_position.entry_time)) / 60,
    now(),
    v_position.entry_alert,
    v_position.position_id,
    v_position.entry_wallet
  );

  update public.tiered_state
  set bankroll_sol = bankroll_sol + v_proceeds_sol,
      daily_realized_pnl_sol = v_daily_pnl,
      consecutive_hard_stops = v_consecutive_hard_stops,
      halted = v_halted,
      halt_reason = v_halt_reason,
      updated_at = now()
  where id = 1
  returning * into v_state;

  if v_terminal then
    delete from public.tiered_positions where position_id = p_position_id;
  else
    update public.tiered_positions
    set remaining_pct = v_remaining_pct,
        peak_multiple = greatest(peak_multiple, coalesce(p_peak_multiple, peak_multiple)),
        ladder_hits = coalesce(p_ladder_hits, ladder_hits),
        realized_pnl_sol = v_realized_pnl_sol
    where position_id = p_position_id;
  end if;

  return jsonb_build_object(
    'applied', true,
    'terminal', v_terminal,
    'sold_pct', v_sold_pct,
    'sold_size_sol', v_sold_size_sol,
    'proceeds_sol', v_proceeds_sol,
    'pnl_sol', v_pnl_sol,
    'remaining_pct', v_remaining_pct,
    'bankroll_sol', v_state.bankroll_sol,
    'daily_realized_pnl_sol', v_state.daily_realized_pnl_sol,
    'consecutive_hard_stops', v_state.consecutive_hard_stops,
    'halted', v_state.halted,
    'halt_reason', v_state.halt_reason
  );
end;
$$;

create or replace function public.tiered_record_peak(
  p_position_id text,
  p_peak_multiple numeric
) returns void
language sql
security definer
set search_path = public
as $$
  update public.tiered_positions
  set peak_multiple = greatest(peak_multiple, p_peak_multiple)
  where position_id = p_position_id;
$$;

create or replace function public.tiered_ledger_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.tiered_state%rowtype;
  v_total_deployed numeric := 0;
  v_total_proceeds numeric := 0;
  v_expected_cash numeric := 0;
  v_open_cost numeric := 0;
  v_total_pnl numeric := 0;
  v_daily_pnl numeric := 0;
  v_completed integer := 0;
  v_wins integer := 0;
  v_losses integer := 0;
  v_gross_profit numeric := 0;
  v_gross_loss numeric := 0;
  v_entries_today integer := 0;
  v_day_start timestamptz := date_trunc('day', timezone('Asia/Jerusalem', now())) at time zone 'Asia/Jerusalem';
begin
  select * into v_state from public.tiered_state where id = 1;
  if not found then
    raise exception 'tiered_state row 1 is missing';
  end if;

  with trade_groups as (
    select position_id,
           sum(sold_size_sol) as sold_size_sol,
           sum(proceeds_sol) as proceeds_sol,
           sum(pnl_sol) as pnl_sol,
           sum(sold_pct) as sold_pct
    from public.tiered_trades
    group by position_id
  ), deployed as (
    select p.position_id, p.size_sol as initial_size_sol
    from public.tiered_positions p
    union all
    select tg.position_id, tg.sold_size_sol
    from trade_groups tg
    where not exists (
      select 1 from public.tiered_positions p where p.position_id = tg.position_id
    )
  )
  select coalesce(sum(initial_size_sol), 0)
  into v_total_deployed
  from deployed;

  select coalesce(sum(proceeds_sol), 0),
         coalesce(sum(pnl_sol), 0),
         coalesce(sum(pnl_sol) filter (where happened_at >= v_day_start), 0)
  into v_total_proceeds, v_total_pnl, v_daily_pnl
  from public.tiered_trades;

  select coalesce(sum(size_sol * remaining_pct), 0)
  into v_open_cost
  from public.tiered_positions;

  with completed as (
    select position_id, sum(pnl_sol) as pnl_sol, sum(sold_pct) as sold_pct
    from public.tiered_trades
    group by position_id
    having sum(sold_pct) >= 0.999
  )
  select count(*)::integer,
         count(*) filter (where pnl_sol > 0)::integer,
         count(*) filter (where pnl_sol <= 0)::integer,
         coalesce(sum(pnl_sol) filter (where pnl_sol > 0), 0),
         abs(coalesce(sum(pnl_sol) filter (where pnl_sol < 0), 0))
  into v_completed, v_wins, v_losses, v_gross_profit, v_gross_loss
  from completed;

  select count(*)::integer
  into v_entries_today
  from public.tiered_processed_signals
  where entered = true and seen_at >= v_day_start;

  v_expected_cash := v_state.starting_bankroll_sol - v_total_deployed + v_total_proceeds;

  return jsonb_build_object(
    'starting_bankroll_sol', v_state.starting_bankroll_sol,
    'reported_cash_sol', v_state.bankroll_sol,
    'expected_cash_sol', v_expected_cash,
    'accounting_discrepancy_sol', v_state.bankroll_sol - v_expected_cash,
    'accounting_ok', abs(v_state.bankroll_sol - v_expected_cash) < 0.0001,
    'open_position_cost_sol', v_open_cost,
    'equity_at_cost_sol', v_expected_cash + v_open_cost,
    'total_realized_pnl_sol', v_total_pnl,
    'daily_realized_pnl_sol', v_daily_pnl,
    'completed_positions', v_completed,
    'wins', v_wins,
    'losses', v_losses,
    'gross_profit_sol', v_gross_profit,
    'gross_loss_sol', v_gross_loss,
    'profit_factor', case when v_gross_loss > 0 then v_gross_profit / v_gross_loss else null end,
    'entries_today', v_entries_today,
    'open_positions', (select count(*) from public.tiered_positions),
    'halted', v_state.halted,
    'halt_reason', v_state.halt_reason,
    'risk_entries_today', v_state.entries_today,
    'risk_daily_realized_pnl_sol', v_state.daily_realized_pnl_sol,
    'consecutive_hard_stops', v_state.consecutive_hard_stops
  );
end;
$$;

create or replace function public.tiered_reconcile_bankroll()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.tiered_state%rowtype;
  v_total_deployed numeric := 0;
  v_total_proceeds numeric := 0;
  v_expected_cash numeric := 0;
begin
  select * into v_state
  from public.tiered_state
  where id = 1
  for update;

  if not found then
    raise exception 'tiered_state row 1 is missing';
  end if;

  with trade_groups as (
    select position_id, sum(sold_size_sol) as sold_size_sol
    from public.tiered_trades
    group by position_id
  ), deployed as (
    select p.position_id, p.size_sol as initial_size_sol
    from public.tiered_positions p
    union all
    select tg.position_id, tg.sold_size_sol
    from trade_groups tg
    where not exists (
      select 1 from public.tiered_positions p where p.position_id = tg.position_id
    )
  )
  select coalesce(sum(initial_size_sol), 0)
  into v_total_deployed
  from deployed;

  select coalesce(sum(proceeds_sol), 0)
  into v_total_proceeds
  from public.tiered_trades;

  v_expected_cash := v_state.starting_bankroll_sol - v_total_deployed + v_total_proceeds;

  update public.tiered_state
  set bankroll_sol = v_expected_cash,
      updated_at = now()
  where id = 1;

  return public.tiered_ledger_snapshot();
end;
$$;

create or replace function public.tiered_resume()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.tiered_state%rowtype;
begin
  update public.tiered_state
  set halted = false,
      halt_reason = null,
      daily_date = (timezone('Asia/Jerusalem', now()))::date,
      entries_today = 0,
      daily_realized_pnl_sol = 0,
      consecutive_hard_stops = 0,
      updated_at = now()
  where id = 1
  returning * into v_state;

  return jsonb_build_object(
    'resumed', true,
    'bankroll_sol', v_state.bankroll_sol,
    'entries_today', v_state.entries_today,
    'daily_realized_pnl_sol', v_state.daily_realized_pnl_sol,
    'consecutive_hard_stops', v_state.consecutive_hard_stops
  );
end;
$$;

revoke all on function public.tiered_open_position(text, text, numeric, timestamptz, numeric, jsonb, text, text, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.tiered_apply_exit(text, numeric, numeric, text, boolean, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.tiered_record_peak(text, numeric) from public, anon, authenticated;
revoke all on function public.tiered_ledger_snapshot() from public, anon, authenticated;
revoke all on function public.tiered_reconcile_bankroll() from public, anon, authenticated;
revoke all on function public.tiered_resume() from public, anon, authenticated;

grant execute on function public.tiered_open_position(text, text, numeric, timestamptz, numeric, jsonb, text, text, numeric, jsonb) to service_role;
grant execute on function public.tiered_apply_exit(text, numeric, numeric, text, boolean, numeric, jsonb) to service_role;
grant execute on function public.tiered_record_peak(text, numeric) to service_role;
grant execute on function public.tiered_ledger_snapshot() to service_role;
grant execute on function public.tiered_reconcile_bankroll() to service_role;
grant execute on function public.tiered_resume() to service_role;
