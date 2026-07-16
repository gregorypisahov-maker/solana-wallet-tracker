import { getSupabaseAdmin } from '../lib/supabase';
import { config } from './config';

export interface AdaptiveEntryThresholds {
  minScore: number;
  minAvgBuyPerWallet: number;
  minLiquidityToMcapRatio: number;
  minLiquidityUsd: number;
}

const BASE: AdaptiveEntryThresholds = { ...config.entry };
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
};

function metrics(rows: PositionSample[]) {
  const wins = rows.filter((r) => r.pnl > 0);
  const losses = rows.filter((r) => r.pnl < 0);
  const grossProfit = wins.reduce((s, r) => s + r.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
  return {
    sample: rows.length,
    pnl: rows.reduce((s, r) => s + r.pnl, 0),
    winRate: rows.length ? wins.length / rows.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9.99 : 0,
  };
}

export async function learnAdaptiveStrategy(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('paper_trades')
      .select('position_id,pnl_sol,entry_alert,happened_at')
      .not('position_id', 'is', null)
      .order('happened_at', { ascending: false })
      .limit(600);
    if (error) throw new Error(error.message);

    const grouped = new Map<string, { pnl: number; alert: any }>();
    for (const row of data ?? []) {
      const id = String(row.position_id);
      const item = grouped.get(id) ?? { pnl: 0, alert: row.entry_alert ?? {} };
      item.pnl += Number(row.pnl_sol ?? 0);
      if (!item.alert || Object.keys(item.alert).length === 0) item.alert = row.entry_alert ?? {};
      grouped.set(id, item);
    }

    const samples: PositionSample[] = [...grouped.values()].slice(0, 150).map(({ pnl, alert }) => ({
      pnl,
      score: Number(alert.score ?? 0),
      walletCount: Number(alert.walletCount ?? alert.wallet_count ?? 0),
      totalBoughtSol: Number(alert.totalBoughtSol ?? alert.total_bought_sol ?? 0),
      liquidityUsd: Number(alert.liquidityUsd ?? alert.liquidity_usd ?? 0),
      marketCapUsd: Number(alert.marketCapUsd ?? alert.market_cap_usd ?? 0),
    })).filter((r) => Number.isFinite(r.pnl) && r.score > 0 && r.walletCount > 0);

    const overall = metrics(samples);
    let next = { ...BASE };
    let reason = `learning only: ${overall.sample} completed positions`;

    // Do not adapt on a tiny sample. Once enabled, changes remain deliberately small.
    if (overall.sample >= 50) {
      const scoreChoices = [8, 9, 10].map((threshold) => ({
        threshold,
        m: metrics(samples.filter((r) => r.score >= threshold)),
      })).filter((x) => x.m.sample >= 15);
      const bestScore = scoreChoices.sort((a, b) =>
        (b.m.profitFactor + b.m.pnl * 0.2) - (a.m.profitFactor + a.m.pnl * 0.2)
      )[0];
      if (bestScore) next.minScore = bestScore.threshold;

      const buyChoices = [0.5, 0.75, 1.0].map((threshold) => ({
        threshold,
        m: metrics(samples.filter((r) => r.totalBoughtSol / r.walletCount >= threshold)),
      })).filter((x) => x.m.sample >= 15);
      const bestBuy = buyChoices.sort((a, b) =>
        (b.m.profitFactor + b.m.pnl * 0.2) - (a.m.profitFactor + a.m.pnl * 0.2)
      )[0];
      if (bestBuy) next.minAvgBuyPerWallet = bestBuy.threshold;

      // Safety bias after a weak sample; never loosen liquidity safeguards.
      if (overall.profitFactor < 1 || overall.pnl < 0) {
        next.minScore = Math.max(9, next.minScore);
        next.minAvgBuyPerWallet = Math.max(0.75, next.minAvgBuyPerWallet);
      }
      reason = `adapted from ${overall.sample} positions; PF ${overall.profitFactor.toFixed(2)}, win ${(overall.winRate * 100).toFixed(1)}%`;
    }

    current = next;
    const { error: saveError } = await supabase.from('adaptive_strategy_state').upsert({
      id: 1,
      enabled: true,
      sample_size: overall.sample,
      min_score: next.minScore,
      min_avg_buy_per_wallet: next.minAvgBuyPerWallet,
      min_liquidity_to_mcap_ratio: next.minLiquidityToMcapRatio,
      min_liquidity_usd: next.minLiquidityUsd,
      profit_factor: overall.profitFactor,
      win_rate: overall.winRate,
      total_pnl_sol: overall.pnl,
      reason,
      updated_at: new Date().toISOString(),
    });
    if (saveError) throw new Error(saveError.message);

    console.log(`[adaptive-strategy] ${reason}; score>=${next.minScore}, avgBuy>=${next.minAvgBuyPerWallet} SOL`);
  } catch (error) {
    console.error('[adaptive-strategy] learning failed safely:', error);
    current = { ...BASE };
  } finally {
    running = false;
  }
}

export function startAdaptiveStrategyScheduler(): void {
  void learnAdaptiveStrategy();
  setInterval(() => void learnAdaptiveStrategy(), 6 * 60 * 60 * 1000);
  console.log('[adaptive-strategy] enabled; learns every 6h from paper trades only');
}
