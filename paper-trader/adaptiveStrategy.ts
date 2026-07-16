import { getSupabaseAdmin } from '../lib/supabase';
import { config } from './config';

export interface AdaptiveEntryThresholds {
  minScore: number;
  minAvgBuyPerWallet: number;
  minLiquidityToMcapRatio: number;
  minLiquidityUsd: number;
}

const BASE: AdaptiveEntryThresholds = {
  minScore: config.entry.minScore,
  minAvgBuyPerWallet: config.entry.minAvgBuyPerWallet,
  minLiquidityToMcapRatio: config.entry.minLiquidityToMcapRatio,
  minLiquidityUsd: config.entry.minLiquidityUsd,
};

// Live paper trading always uses the productive baseline. The learner still
// records performance, but it may no longer choke trade flow by changing live
// thresholds from a small historical subset.
let current: AdaptiveEntryThresholds = { ...BASE };
let running = false;

export function getAdaptiveEntryThresholds(): AdaptiveEntryThresholds {
  return current;
}

type PositionSample = {
  pnl: number;
  score: number;
  walletCount: number;
  totalBoughtSol: number;
  liquidityUsd: number;
  marketCapUsd: number;
  happenedAt: string;
};

type StrategyMetrics = {
  sample: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
};

function metrics(rows: PositionSample[]): StrategyMetrics {
  const wins = rows.filter((row) => row.pnl > 0);
  const losses = rows.filter((row) => row.pnl < 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.pnl, 0));

  return {
    sample: rows.length,
    pnl: rows.reduce((sum, row) => sum + row.pnl, 0),
    winRate: rows.length ? wins.length / rows.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9.99 : 0,
  };
}

export async function learnAdaptiveStrategy(): Promise<void> {
  if (running) return;
  running = true;

  try {
    // Reset on every refresh so stale Supabase overrides or previous in-memory
    // values cannot make the live paper strategy progressively stricter.
    current = { ...BASE };

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('paper_trades')
      .select('position_id,pnl_sol,entry_alert,happened_at')
      .not('position_id', 'is', null)
      .order('happened_at', { ascending: false })
      .limit(900);

    if (error) throw new Error(error.message);

    const grouped = new Map<string, { pnl: number; alert: any; happenedAt: string }>();
    for (const row of data ?? []) {
      const id = String(row.position_id);
      const item = grouped.get(id) ?? {
        pnl: 0,
        alert: row.entry_alert ?? {},
        happenedAt: String(row.happened_at ?? ''),
      };
      item.pnl += Number(row.pnl_sol ?? 0);
      if (!item.alert || Object.keys(item.alert).length === 0) item.alert = row.entry_alert ?? {};
      if (String(row.happened_at ?? '') > item.happenedAt) item.happenedAt = String(row.happened_at ?? '');
      grouped.set(id, item);
    }

    const samples: PositionSample[] = [...grouped.values()]
      .map(({ pnl, alert, happenedAt }) => ({
        pnl,
        score: Number(alert.score ?? 0),
        walletCount: Number(alert.walletCount ?? alert.wallet_count ?? 0),
        totalBoughtSol: Number(alert.totalBoughtSol ?? alert.total_bought_sol ?? 0),
        liquidityUsd: Number(alert.liquidityUsd ?? alert.liquidity_usd ?? 0),
        marketCapUsd: Number(alert.marketCapUsd ?? alert.market_cap_usd ?? 0),
        happenedAt,
      }))
      .filter((row) => Number.isFinite(row.pnl) && row.score > 0 && row.walletCount > 0)
      .sort((a, b) => b.happenedAt.localeCompare(a.happenedAt))
      .slice(0, 240);

    const overall = metrics(samples);
    const reason = `monitoring-only baseline from ${overall.sample} positions; PF ${overall.profitFactor.toFixed(2)}`;

    const { error: saveError } = await supabase.from('adaptive_strategy_state').upsert({
      id: 1,
      enabled: false,
      sample_size: overall.sample,
      min_score: BASE.minScore,
      min_avg_buy_per_wallet: BASE.minAvgBuyPerWallet,
      min_liquidity_to_mcap_ratio: BASE.minLiquidityToMcapRatio,
      min_liquidity_usd: BASE.minLiquidityUsd,
      profit_factor: overall.profitFactor,
      win_rate: overall.winRate,
      total_pnl_sol: overall.pnl,
      reason,
      updated_at: new Date().toISOString(),
    });

    if (saveError) throw new Error(saveError.message);

    console.log(
      `[adaptive-strategy] live tuning disabled; baseline restored: ` +
        `score>=${BASE.minScore}, avgBuy>=${BASE.minAvgBuyPerWallet} SOL, ` +
        `liq/mcap>=${(BASE.minLiquidityToMcapRatio * 100).toFixed(1)}%, ` +
        `liquidity>=${BASE.minLiquidityUsd}; observed PF ${overall.profitFactor.toFixed(2)}`,
    );
  } catch (error) {
    console.error('[adaptive-strategy] monitoring failed safely:', error);
    current = { ...BASE };
  } finally {
    running = false;
  }
}

export function startAdaptiveStrategyScheduler(): void {
  void learnAdaptiveStrategy();
  setInterval(() => void learnAdaptiveStrategy(), 6 * 60 * 60 * 1000);
  console.log('[adaptive-strategy] monitoring-only mode; live entry thresholds stay fixed');
}
