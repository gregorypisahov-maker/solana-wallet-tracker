-- Production-history review query for the live winner-aligned rug veto.
-- Run read-only against Supabase. It does not alter data.
with t as (
  select
    token_symbol,
    pnl_sol,
    net_return_pct,
    exit_reason,
    nullif(entry_snapshot #>> '{opportunity,pool_age_minutes}','')::numeric as age_m,
    nullif(entry_snapshot #>> '{opportunity,buyers_m5}','')::numeric as buyers_m5,
    nullif(entry_snapshot #>> '{opportunity,signal_snapshot,buyRatio}','')::numeric as buy_ratio,
    nullif(entry_snapshot #>> '{opportunity,price_change_h1}','')::numeric as h1_change,
    coalesce(entry_snapshot #> '{opportunity,risks}', '[]'::jsonb) as risks,
    (exit_reason = 'emergency_liquidity_drop' or coalesce(net_return_pct,0) <= -40) as is_rug,
    (coalesce(pnl_sol,0) > 0) as is_win
  from public.ai_discovery_trades
  where closed_at is not null
), scored as (
  select *,
    (
      age_m < 90
      and h1_change >= 35
      and (
        buyers_m5 < 100
        or buy_ratio <= 0.57
        or risks ? 'possible_churn_or_fake_volume'
      )
    ) as historical_rug_pattern
  from t
)
select
  count(*) filter (where historical_rug_pattern and is_rug) as known_rugs_blocked,
  count(*) filter (where is_rug) as total_known_rugs,
  count(*) filter (where historical_rug_pattern and is_win) as winners_blocked,
  count(*) filter (where is_win) as total_winners,
  round(sum(pnl_sol) filter (where historical_rug_pattern), 6) as blocked_pnl,
  round(sum(pnl_sol) filter (where not historical_rug_pattern), 6) as kept_pnl
from scored;
