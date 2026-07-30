begin;

alter table if exists public.ai_discovery_trades
  add column if not exists modeled_executable_net_return_pct double precision,
  add column if not exists modeled_stress_net_return_pct double precision,
  add column if not exists modeled_executable_pnl_sol double precision,
  add column if not exists modeled_stress_pnl_sol double precision,
  add column if not exists execution_model_status text,
  add column if not exists execution_model_version text,
  add column if not exists entry_executable_price_usd double precision,
  add column if not exists exit_executable_price_usd double precision,
  add column if not exists entry_price_disadvantage_pct double precision,
  add column if not exists exit_price_disadvantage_pct double precision,
  add column if not exists entry_price_impact_pct double precision,
  add column if not exists exit_price_impact_pct double precision,
  add column if not exists execution_costs jsonb not null default '{}'::jsonb;

alter table if exists public.live_positions
  add column if not exists predicted_net_return_pct double precision,
  add column if not exists predicted_net_pnl_sol double precision,
  add column if not exists realized_net_return_pct double precision,
  add column if not exists prediction_error_pct double precision,
  add column if not exists reconciliation_status text,
  add column if not exists reconciliation_delta_sol double precision,
  add column if not exists execution_telemetry jsonb not null default '{}'::jsonb;

create index if not exists ai_discovery_trades_execution_model_idx
  on public.ai_discovery_trades (execution_model_status, closed_at desc);

create or replace view public.ai_execution_parity_scoreboard as
select
  count(*) filter (where execution_model_status = 'modeled')::bigint as modeled_trades,
  count(*) filter (where execution_model_status = 'entry_unavailable')::bigint as entry_unavailable,
  count(*) filter (where execution_model_status = 'exit_unavailable')::bigint as exit_unavailable,
  round(avg(modeled_executable_net_return_pct)::numeric, 4) as avg_executable_net_pct,
  round(avg(modeled_stress_net_return_pct)::numeric, 4) as avg_stress_net_pct,
  round(sum(modeled_executable_pnl_sol)::numeric, 8) as total_executable_pnl_sol,
  round(sum(modeled_stress_pnl_sol)::numeric, 8) as total_stress_pnl_sol,
  round((100.0 * avg(case when modeled_executable_net_return_pct > 0 then 1 else 0 end))::numeric, 2) as executable_positive_rate_pct,
  round(percentile_cont(0.5) within group (order by entry_price_disadvantage_pct)::numeric, 4) as median_entry_disadvantage_pct,
  round(percentile_cont(0.9) within group (order by entry_price_disadvantage_pct)::numeric, 4) as p90_entry_disadvantage_pct,
  round(percentile_cont(0.5) within group (order by exit_price_disadvantage_pct)::numeric, 4) as median_exit_disadvantage_pct,
  round(percentile_cont(0.9) within group (order by exit_price_disadvantage_pct)::numeric, 4) as p90_exit_disadvantage_pct
from public.ai_discovery_trades
where execution_model_version is not null;

create or replace view public.real_vs_paper_scoreboard as
select
  count(*) filter (where lp.status = 'closed')::bigint as completed_round_trips,
  round((100.0 * avg(case when lp.realized_pnl_sol > 0 then 1 else 0 end))::numeric, 2) as realized_win_rate_pct,
  round(avg(lp.realized_pnl_sol)::numeric, 8) as realized_avg_net_sol,
  round(sum(lp.realized_pnl_sol)::numeric, 8) as realized_total_net_sol,
  round(avg(lp.predicted_net_pnl_sol)::numeric, 8) as predicted_avg_net_sol,
  round(avg(lp.prediction_error_pct)::numeric, 4) as mean_error_pct,
  round(percentile_cont(0.5) within group (order by abs(lp.prediction_error_pct))::numeric, 4) as median_absolute_error_pct,
  round(percentile_cont(0.9) within group (order by abs(lp.prediction_error_pct))::numeric, 4) as p90_absolute_error_pct,
  count(*) filter (where coalesce(lp.reconciliation_status, '') = 'failed')::bigint as reconciliation_failures,
  count(*) filter (where coalesce(lp.execution_telemetry->>'partial_or_failed_tx', 'false') = 'true')::bigint as failed_or_partial_transactions
from public.live_positions lp
where lp.status = 'closed';

-- Canary defaults. They remain inert unless both runtime flags and the DB gate are enabled.
update public.live_executor_state
set max_position_sol = least(coalesce(max_position_sol, 0.02), 0.02),
    max_open_positions = 1,
    enabled = false,
    halted = true,
    halt_reason = 'real_readiness_validation_required',
    updated_at = now()
where id = 1;

commit;
