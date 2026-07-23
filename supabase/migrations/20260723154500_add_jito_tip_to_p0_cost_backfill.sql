-- P0 v2: add the separately calibrated Jito tip omitted from v1.
--
-- Calibration at 2026-07-23 12:40:34 UTC:
--   Jito landed-tips 99th percentile = 0.0000998 SOL.
-- The correction is idempotent because it only touches v1 cost-model rows.

begin;

create temp table _p0_jito_tip_constants as
select 0.0000998::numeric tip_sol,
       0.05::numeric failed_entry_rate,
       'p0_jupiter_pumpswap_2026_07_23_v1'::text runtime_v1,
       'p0_jupiter_pumpswap_2026_07_23_v1_backfill_failrate5pct'::text backfill_v1,
       'p0_jupiter_pumpswap_jito_2026_07_23_v2'::text runtime_v2,
       'p0_jupiter_pumpswap_jito_2026_07_23_v2_backfill_failrate5pct'::text backfill_v2;

create temp table _p0_main_tip_delta as
with affected as (
  select t.id,
         case
           when t.cost_model_version = c.backfill_v1
             then (c.tip_sol + c.tip_sol*c.failed_entry_rate/(1-c.failed_entry_rate))*t.sold_pct::numeric
           else c.tip_sol*t.sold_pct::numeric
         end as extra_entry_fee,
         c.tip_sol as extra_exit_fee,
         case when t.cost_model_version = c.backfill_v1 then c.backfill_v2 else c.runtime_v2 end as new_version
  from public.paper_trades t cross join _p0_jito_tip_constants c
  where t.cost_model_version in (c.runtime_v1,c.backfill_v1)
), updated as (
  update public.paper_trades t
  set entry_fee_sol = t.entry_fee_sol + a.extra_entry_fee,
      exit_fee_sol = t.exit_fee_sol + a.extra_exit_fee,
      pnl_sol = t.pnl_sol - a.extra_entry_fee - a.extra_exit_fee,
      proceeds_sol = t.proceeds_sol - a.extra_exit_fee,
      cost_model_version = a.new_version
  from affected a
  where t.id = a.id
  returning a.extra_entry_fee + a.extra_exit_fee as extra_cost
)
select coalesce(sum(extra_cost),0)::numeric as extra_cost from updated;

create temp table _p0_shadow_tip_delta as
with affected as (
  select t.id,
         case
           when t.cost_model_version = c.backfill_v1
             then (c.tip_sol + c.tip_sol*c.failed_entry_rate/(1-c.failed_entry_rate))*t.sold_pct::numeric
           else c.tip_sol*t.sold_pct::numeric
         end as extra_entry_fee,
         c.tip_sol as extra_exit_fee,
         case when t.cost_model_version = c.backfill_v1 then c.backfill_v2 else c.runtime_v2 end as new_version
  from public.shadow_trades t cross join _p0_jito_tip_constants c
  where t.cost_model_version in (c.runtime_v1,c.backfill_v1)
), updated as (
  update public.shadow_trades t
  set entry_fee_sol = t.entry_fee_sol + a.extra_entry_fee,
      exit_fee_sol = t.exit_fee_sol + a.extra_exit_fee,
      pnl_sol = t.pnl_sol - a.extra_entry_fee - a.extra_exit_fee,
      cost_model_version = a.new_version
  from affected a
  where t.id = a.id
  returning a.extra_entry_fee + a.extra_exit_fee as extra_cost
)
select coalesce(sum(extra_cost),0)::numeric as extra_cost from updated;

create temp table _p0_tiered_tip_delta as
with affected as (
  select t.id,
         case
           when t.cost_model_version = c.backfill_v1
             then (c.tip_sol + c.tip_sol*c.failed_entry_rate/(1-c.failed_entry_rate))*t.sold_pct::numeric
           else c.tip_sol*t.sold_pct::numeric
         end as extra_entry_fee,
         c.tip_sol as extra_exit_fee,
         case when t.cost_model_version = c.backfill_v1 then c.backfill_v2 else c.runtime_v2 end as new_version
  from public.tiered_trades t cross join _p0_jito_tip_constants c
  where t.cost_model_version in (c.runtime_v1,c.backfill_v1)
), updated as (
  update public.tiered_trades t
  set entry_fee_sol = t.entry_fee_sol + a.extra_entry_fee,
      exit_fee_sol = t.exit_fee_sol + a.extra_exit_fee,
      pnl_sol = t.pnl_sol - a.extra_entry_fee - a.extra_exit_fee,
      proceeds_sol = t.proceeds_sol - a.extra_exit_fee,
      cost_model_version = a.new_version
  from affected a
  where t.id = a.id
  returning a.extra_entry_fee + a.extra_exit_fee as extra_cost
)
select coalesce(sum(extra_cost),0)::numeric as extra_cost from updated;

-- If any v1 failed-entry rows landed during the deployment window, add the tip
-- and charge the corresponding paper bankroll atomically in this migration.
create temp table _p0_failed_tip_delta as
with affected as (
  select f.id,f.strategy,c.tip_sol,c.runtime_v2
  from public.paper_failed_entries f cross join _p0_jito_tip_constants c
  where f.cost_model_version = c.runtime_v1
), updated as (
  update public.paper_failed_entries f
  set network_fee_sol = f.network_fee_sol + a.tip_sol,
      cost_model_version = a.runtime_v2,
      cost_snapshot = f.cost_snapshot || jsonb_build_object(
        'jito_tip_sol_per_transaction',a.tip_sol,
        'network_cost_corrected_to_v2',true
      )
  from affected a
  where f.id = a.id
  returning f.strategy,a.tip_sol
)
select strategy,coalesce(sum(tip_sol),0)::numeric as extra_cost
from updated group by strategy;

update public.paper_state s
set bankroll_sol = s.bankroll_sol - d.extra_cost - coalesce(f.extra_cost,0),
    daily_start_bankroll_sol = s.daily_start_bankroll_sol - d.extra_cost - coalesce(f.extra_cost,0),
    updated_at = now()
from _p0_main_tip_delta d
left join _p0_failed_tip_delta f on f.strategy='MAIN'
where s.id=1 and d.extra_cost + coalesce(f.extra_cost,0) <> 0;

update public.shadow_strategy_state s
set bankroll_sol = s.bankroll_sol - d.extra_cost - coalesce(f.extra_cost,0),
    updated_at = now()
from _p0_shadow_tip_delta d
left join _p0_failed_tip_delta f on f.strategy='SHADOW'
where s.id=1 and d.extra_cost + coalesce(f.extra_cost,0) <> 0;

update public.tiered_state s
set bankroll_sol = s.bankroll_sol - d.extra_cost - coalesce(f.extra_cost,0),
    updated_at = now()
from _p0_tiered_tip_delta d
left join _p0_failed_tip_delta f on f.strategy='TIERED'
where s.id=1 and d.extra_cost + coalesce(f.extra_cost,0) <> 0;

commit;
