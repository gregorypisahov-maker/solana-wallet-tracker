-- Idempotent historical backfill for P0 explicit paper costs.
-- Calibration: p0_jupiter_pumpswap_2026_07_23_v1
-- Network: 0.00023043 SOL/tx (Jupiter HIGH + Solana base fee)
-- Swap fee: 1.25% per side
-- Slippage: 2.0 * trade_notional_usd / pool_liquidity_usd
-- SOL reference: $76.6981212318335
-- Failed-entry scenario: 5%; expected failed network fees are allocated to
-- successful positions because historical failed attempts were not recorded.

begin;

create temp table _p0_constants as
select 0.00023043::numeric network_fee,
       0.0125::numeric swap_fee,
       2.0::numeric slip_k,
       76.6981212318335::numeric sol_usd,
       0.05::numeric fail_rate,
       'p0_jupiter_pumpswap_2026_07_23_v1_backfill_failrate5pct'::text version;

create temp table _p0_main_calc as
with base as (
  select t.*,
         coalesce(t.position_id, 'legacy_' || t.id)::text logical_id,
         nullif((t.entry_alert->>'liquidityUsd')::numeric, 0) liquidity,
         case when t.sold_pct::numeric > 0
              then t.sold_size_sol::numeric / t.sold_pct::numeric
              else t.sold_size_sol::numeric end original_size,
         (t.exit_price::numeric / 0.994) / (t.entry_price::numeric / 1.006) gross_multiple
  from public.paper_trades t
  where t.cost_model_version is null
), positions as (
  select logical_id,
         max(original_size) original_size,
         max(liquidity) liquidity
  from base group by logical_id
), calc as (
  select b.id,
         b.sold_size_sol::numeric * b.gross_multiple gross_proceeds,
         b.sold_size_sol::numeric * (b.gross_multiple - 1) gross_pnl,
         ((p.original_size*c.swap_fee + c.network_fee + c.network_fee*c.fail_rate/(1-c.fail_rate)) * b.sold_pct::numeric) entry_fee,
         (b.sold_size_sol::numeric*b.gross_multiple*c.swap_fee + c.network_fee) exit_fee,
         ((c.slip_k*(p.original_size*c.sol_usd/p.liquidity)*p.original_size)*b.sold_pct::numeric
          + c.slip_k*((b.sold_size_sol::numeric*b.gross_multiple*c.sol_usd)/p.liquidity)
                    *(b.sold_size_sol::numeric*b.gross_multiple)) slippage,
         c.version
  from base b join positions p using(logical_id) cross join _p0_constants c
  where p.liquidity > 0
)
select id, gross_proceeds, gross_pnl, entry_fee, exit_fee, slippage,
       gross_pnl-entry_fee-exit_fee-slippage net_pnl,
       gross_proceeds-exit_fee-(slippage -
         ((select slip_k from _p0_constants)*(p.original_size*(select sol_usd from _p0_constants)/p.liquidity)*p.original_size)*b.sold_pct::numeric
       ) net_exit_proceeds,
       version
from calc
join base b using(id)
join positions p using(logical_id);

create temp table _p0_main_delta as
select coalesce(sum(c.net_pnl - t.pnl_sol::numeric),0)::numeric delta
from _p0_main_calc c join public.paper_trades t using(id);

update public.paper_trades t
set entry_fee_sol = c.entry_fee,
    exit_fee_sol = c.exit_fee,
    slippage_sol = c.slippage,
    gross_pnl_sol = c.gross_pnl,
    pnl_sol = c.net_pnl,
    proceeds_sol = c.net_exit_proceeds,
    cost_model_version = c.version
from _p0_main_calc c where t.id=c.id;

update public.paper_state
set bankroll_sol = bankroll_sol + d.delta,
    daily_start_bankroll_sol = daily_start_bankroll_sol + d.delta,
    updated_at = now()
from _p0_main_delta d where id=1 and d.delta<>0;

create temp table _p0_shadow_calc as
with base as (
  select t.*,
         coalesce(t.position_id, 'legacy_' || t.id)::text logical_id,
         nullif((t.entry_alert->>'liquidityUsd')::numeric,0) liquidity,
         coalesce(
           (t.entry_alert->'shadowStudyDecision'->>'final_shadow_size_sol')::numeric,
           (t.entry_alert->'shadowStudyDecision'->>'normal_shadow_size_sol')::numeric,
           case when abs(t.multiple::numeric-1)>0.0000001
                then (t.pnl_sol::numeric/(t.multiple::numeric-1))/nullif(t.sold_pct::numeric,0) end,
           0.30::numeric
         ) original_size
  from public.shadow_trades t
  where t.cost_model_version is null
), calc as (
  select b.id,
         b.original_size*b.sold_pct::numeric sold_size,
         b.original_size*b.sold_pct::numeric*b.multiple::numeric gross_proceeds,
         b.original_size*b.sold_pct::numeric*(b.multiple::numeric-1) gross_pnl,
         ((b.original_size*c.swap_fee+c.network_fee+c.network_fee*c.fail_rate/(1-c.fail_rate))*b.sold_pct::numeric) entry_fee,
         (b.original_size*b.sold_pct::numeric*b.multiple::numeric*c.swap_fee+c.network_fee) exit_fee,
         ((c.slip_k*(b.original_size*c.sol_usd/b.liquidity)*b.original_size)*b.sold_pct::numeric
          + c.slip_k*((b.original_size*b.sold_pct::numeric*b.multiple::numeric*c.sol_usd)/b.liquidity)
                    *(b.original_size*b.sold_pct::numeric*b.multiple::numeric)) slippage,
         c.version
  from base b cross join _p0_constants c
  where b.liquidity>0
)
select *, gross_pnl-entry_fee-exit_fee-slippage net_pnl from calc;

create temp table _p0_shadow_delta as
select coalesce(sum(c.net_pnl-t.pnl_sol::numeric),0)::numeric delta
from _p0_shadow_calc c join public.shadow_trades t using(id);

update public.shadow_trades t
set entry_fee_sol=c.entry_fee,
    exit_fee_sol=c.exit_fee,
    slippage_sol=c.slippage,
    gross_pnl_sol=c.gross_pnl,
    pnl_sol=c.net_pnl,
    cost_model_version=c.version
from _p0_shadow_calc c where t.id=c.id;

update public.shadow_strategy_state
set bankroll_sol=bankroll_sol+d.delta, updated_at=now()
from _p0_shadow_delta d where id=1 and d.delta<>0;

create temp table _p0_tiered_calc as
with base as (
  select t.*,
         coalesce(t.position_id,'legacy_'||t.id)::text logical_id,
         nullif((p.filter_snapshot#>>'{market,liquidityUsd}')::numeric,0) liquidity,
         case when t.sold_pct::numeric>0 then t.sold_size_sol::numeric/t.sold_pct::numeric else t.sold_size_sol::numeric end original_size,
         (t.exit_price::numeric/0.994)/(t.entry_price::numeric/1.006) gross_multiple
  from public.tiered_trades t
  left join lateral (
    select filter_snapshot from public.tiered_processed_signals p
    where p.wallet_address=t.entry_wallet and p.token_mint=t.mint
      and p.entered=true and p.seen_at<=t.happened_at
    order by p.seen_at desc limit 1
  ) p on true
  where t.cost_model_version is null
), med as (
  select percentile_cont(0.5) within group(order by liquidity)::numeric median_liquidity
  from base where liquidity>0
), normalized as (
  select b.*,coalesce(b.liquidity,m.median_liquidity,15000::numeric) effective_liquidity
  from base b cross join med m
), positions as (
  select logical_id,max(original_size) original_size,max(effective_liquidity) liquidity
  from normalized group by logical_id
), calc as (
  select b.id,
         b.sold_size_sol::numeric*b.gross_multiple gross_proceeds,
         b.sold_size_sol::numeric*(b.gross_multiple-1) gross_pnl,
         ((p.original_size*c.swap_fee+c.network_fee+c.network_fee*c.fail_rate/(1-c.fail_rate))*b.sold_pct::numeric) entry_fee,
         (b.sold_size_sol::numeric*b.gross_multiple*c.swap_fee+c.network_fee) exit_fee,
         ((c.slip_k*(p.original_size*c.sol_usd/p.liquidity)*p.original_size)*b.sold_pct::numeric
          + c.slip_k*((b.sold_size_sol::numeric*b.gross_multiple*c.sol_usd)/p.liquidity)
                    *(b.sold_size_sol::numeric*b.gross_multiple)) slippage,
         c.version,
         ((c.slip_k*(p.original_size*c.sol_usd/p.liquidity)*p.original_size)*b.sold_pct::numeric) entry_slippage
  from normalized b join positions p using(logical_id) cross join _p0_constants c
)
select *,gross_pnl-entry_fee-exit_fee-slippage net_pnl,
       gross_proceeds-exit_fee-(slippage-entry_slippage) net_exit_proceeds
from calc;

create temp table _p0_tiered_delta as
select coalesce(sum(c.net_pnl-t.pnl_sol::numeric),0)::numeric delta
from _p0_tiered_calc c join public.tiered_trades t using(id);

update public.tiered_trades t
set entry_fee_sol=c.entry_fee,
    exit_fee_sol=c.exit_fee,
    slippage_sol=c.slippage,
    gross_pnl_sol=c.gross_pnl,
    pnl_sol=c.net_pnl,
    proceeds_sol=c.net_exit_proceeds,
    cost_model_version=c.version
from _p0_tiered_calc c where t.id=c.id;

update public.tiered_state
set bankroll_sol=bankroll_sol+d.delta, updated_at=now()
from _p0_tiered_delta d where id=1 and d.delta<>0;

commit;
