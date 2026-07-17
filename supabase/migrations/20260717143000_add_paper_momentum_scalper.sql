create table if not exists public.scalp_state (
  id smallint primary key default 1 check (id = 1),
  bankroll_sol numeric not null default 1 check (bankroll_sol >= 0),
  starting_bankroll_sol numeric not null default 1 check (starting_bankroll_sol > 0),
  enabled boolean not null default true,
  halted boolean not null default false,
  halt_reason text,
  entries_today integer not null default 0 check (entries_today >= 0),
  daily_date date not null default current_date,
  daily_realized_pnl_sol numeric not null default 0,
  consecutive_losses integer not null default 0 check (consecutive_losses >= 0),
  last_scan_at timestamptz,
  last_entry_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.scalp_positions (
  position_id text primary key,
  mint text not null unique,
  token_symbol text not null,
  pair_address text not null,
  entry_price_usd numeric not null check (entry_price_usd > 0),
  entry_time timestamptz not null,
  size_sol numeric not null check (size_sol > 0),
  peak_price_usd numeric not null check (peak_price_usd > 0),
  last_price_usd numeric not null check (last_price_usd > 0),
  last_checked_at timestamptz not null,
  entry_snapshot jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.scalp_trades (
  id bigint generated always as identity primary key,
  position_id text not null unique,
  mint text not null,
  token_symbol text not null,
  pair_address text not null,
  entry_price_usd numeric not null,
  exit_price_usd numeric not null,
  size_sol numeric not null,
  gross_return_pct numeric not null,
  net_return_pct numeric not null,
  pnl_sol numeric not null,
  exit_reason text not null check (
    exit_reason in ('take_profit', 'hard_stop', 'trailing_stop', 'max_hold_time')
  ),
  opened_at timestamptz not null,
  closed_at timestamptz not null default now(),
  entry_snapshot jsonb not null default '{}'::jsonb,
  exit_snapshot jsonb not null default '{}'::jsonb
);

create table if not exists public.scalp_scan_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  status text not null check (status in ('ok', 'error', 'skipped')),
  scanned_count integer not null default 0,
  qualified_count integer not null default 0,
  top_symbol text,
  top_mint text,
  top_score numeric,
  selected_mint text,
  message text,
  top_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists scalp_trades_closed_at_idx
  on public.scalp_trades (closed_at desc);
create index if not exists scalp_trades_mint_closed_at_idx
  on public.scalp_trades (mint, closed_at desc);
create index if not exists scalp_positions_entry_time_idx
  on public.scalp_positions (entry_time desc);
create index if not exists scalp_scan_runs_started_at_idx
  on public.scalp_scan_runs (started_at desc);

alter table public.scalp_state enable row level security;
alter table public.scalp_positions enable row level security;
alter table public.scalp_trades enable row level security;
alter table public.scalp_scan_runs enable row level security;

revoke all on public.scalp_state from anon, authenticated;
revoke all on public.scalp_positions from anon, authenticated;
revoke all on public.scalp_trades from anon, authenticated;
revoke all on public.scalp_scan_runs from anon, authenticated;

insert into public.scalp_state (
  id,
  bankroll_sol,
  starting_bankroll_sol,
  enabled
)
values (1, 1, 1, true)
on conflict (id) do nothing;

create or replace function public.open_paper_scalp(
  p_position_id text,
  p_mint text,
  p_token_symbol text,
  p_pair_address text,
  p_entry_price_usd numeric,
  p_entry_time timestamptz,
  p_size_sol numeric,
  p_entry_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.scalp_state%rowtype;
begin
  select * into v_state
  from public.scalp_state
  where id = 1
  for update;

  if not found then
    raise exception 'scalp state is missing';
  end if;
  if not v_state.enabled then
    raise exception 'scalper is disabled';
  end if;
  if v_state.halted then
    raise exception 'scalper is halted: %', coalesce(v_state.halt_reason, 'risk guard');
  end if;
  if v_state.bankroll_sol < p_size_sol then
    raise exception 'insufficient paper bankroll';
  end if;
  if v_state.entries_today >= 12 then
    raise exception 'daily entry limit reached';
  end if;
  if exists (select 1 from public.scalp_positions) then
    raise exception 'a scalp position is already open';
  end if;

  insert into public.scalp_positions (
    position_id,
    mint,
    token_symbol,
    pair_address,
    entry_price_usd,
    entry_time,
    size_sol,
    peak_price_usd,
    last_price_usd,
    last_checked_at,
    entry_snapshot
  )
  values (
    p_position_id,
    p_mint,
    p_token_symbol,
    p_pair_address,
    p_entry_price_usd,
    p_entry_time,
    p_size_sol,
    p_entry_price_usd,
    p_entry_price_usd,
    p_entry_time,
    coalesce(p_entry_snapshot, '{}'::jsonb)
  );

  update public.scalp_state
  set
    bankroll_sol = bankroll_sol - p_size_sol,
    entries_today = entries_today + 1,
    last_entry_at = p_entry_time,
    updated_at = now()
  where id = 1
  returning * into v_state;

  return jsonb_build_object(
    'bankrollSol', v_state.bankroll_sol,
    'entriesToday', v_state.entries_today
  );
end;
$$;

create or replace function public.close_paper_scalp(
  p_position_id text,
  p_exit_price_usd numeric,
  p_gross_return_pct numeric,
  p_net_return_pct numeric,
  p_pnl_sol numeric,
  p_proceeds_sol numeric,
  p_exit_reason text,
  p_closed_at timestamptz,
  p_exit_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position public.scalp_positions%rowtype;
  v_state public.scalp_state%rowtype;
  v_daily_pnl numeric;
  v_losses integer;
  v_halted boolean;
  v_halt_reason text;
begin
  if p_exit_reason not in (
    'take_profit',
    'hard_stop',
    'trailing_stop',
    'max_hold_time'
  ) then
    raise exception 'invalid scalp exit reason';
  end if;

  select * into v_state
  from public.scalp_state
  where id = 1
  for update;

  select * into v_position
  from public.scalp_positions
  where position_id = p_position_id
  for update;

  if not found then
    raise exception 'scalp position not found';
  end if;

  v_daily_pnl := v_state.daily_realized_pnl_sol + p_pnl_sol;
  v_losses := case
    when p_pnl_sol < 0 then v_state.consecutive_losses + 1
    else 0
  end;
  v_halted := v_state.halted;
  v_halt_reason := v_state.halt_reason;

  if v_daily_pnl <= -0.01 then
    v_halted := true;
    v_halt_reason := 'daily_loss_limit';
  elsif v_losses >= 4 then
    v_halted := true;
    v_halt_reason := 'consecutive_loss_limit';
  elsif v_state.entries_today >= 12 then
    v_halted := true;
    v_halt_reason := 'daily_entry_limit';
  end if;

  insert into public.scalp_trades (
    position_id,
    mint,
    token_symbol,
    pair_address,
    entry_price_usd,
    exit_price_usd,
    size_sol,
    gross_return_pct,
    net_return_pct,
    pnl_sol,
    exit_reason,
    opened_at,
    closed_at,
    entry_snapshot,
    exit_snapshot
  )
  values (
    v_position.position_id,
    v_position.mint,
    v_position.token_symbol,
    v_position.pair_address,
    v_position.entry_price_usd,
    p_exit_price_usd,
    v_position.size_sol,
    p_gross_return_pct,
    p_net_return_pct,
    p_pnl_sol,
    p_exit_reason,
    v_position.entry_time,
    p_closed_at,
    v_position.entry_snapshot,
    coalesce(p_exit_snapshot, '{}'::jsonb)
  );

  delete from public.scalp_positions
  where position_id = p_position_id;

  update public.scalp_state
  set
    bankroll_sol = bankroll_sol + p_proceeds_sol,
    daily_realized_pnl_sol = v_daily_pnl,
    consecutive_losses = v_losses,
    halted = v_halted,
    halt_reason = v_halt_reason,
    updated_at = now()
  where id = 1
  returning * into v_state;

  return jsonb_build_object(
    'bankrollSol', v_state.bankroll_sol,
    'halted', v_state.halted,
    'haltReason', v_state.halt_reason,
    'consecutiveLosses', v_state.consecutive_losses
  );
end;
$$;

revoke all on function public.open_paper_scalp(
  text, text, text, text, numeric, timestamptz, numeric, jsonb
) from public, anon, authenticated;
revoke all on function public.close_paper_scalp(
  text, numeric, numeric, numeric, numeric, numeric, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.open_paper_scalp(
  text, text, text, text, numeric, timestamptz, numeric, jsonb
) to service_role;
grant execute on function public.close_paper_scalp(
  text, numeric, numeric, numeric, numeric, numeric, text, timestamptz, jsonb
) to service_role;
