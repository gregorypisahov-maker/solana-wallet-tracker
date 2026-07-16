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
  happenedAt: string;
};

type StrategyMetrics = {
  sample: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
};

function metrics(rows: PositionSample[]): StrategyMetrics {
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

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function passes(row: PositionSample, thresholds: AdaptiveEntryThresholds): boolean {
  const avgBuy = row.walletCount > 0 ? row.totalBoughtSol / row.walletCount : 0;
  const liqToMcap = row.marketCapUsd > 0 ? row.liquidityUsd / row.marketCapUsd : 0;
  return row.score >= thresholds.minScore &&
    avgBuy >= thresholds.minAvgBuyPerWallet &&
    liqToMcap >= thresholds.minLiquidityToMcapRatio &&
    row.liquidityUsd >= thresholds.minLiquidityUsd;
}

function candidateScore(m: StrategyMetrics, sourceSample: number): number {
  if (!m.sample || !sourceSample) return Number.NEGATIVE_INFINITY;
  const coverage = m.sample / sourceSample;
  // Prefer profit factor and positive PnL, but punish tiny over-fitted subsets.
  return m.profitFactor + Math.min(1, Math.max(-1, m.pnl)) * 0.25 + m.winRate * 0.1 + coverage * 0.15;
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
      .filter((r) => Number.isFinite(r.pnl) && r.score > 0 && r.walletCount > 0)
      .sort((a, b) => b.happenedAt.localeCompare(a.happenedAt))
      .slice(0, 240);

    const overall = metrics(samples);
    let next = { ...BASE };
    let reason = `learning only: ${overall.sample} completed positions`;

    if (overall.sample >= 80) {
      // Older observations select the strategy; the newest observations must confirm it.
      // This prevents one lucky recent cluster from loosening or tightening live paper rules.
      const validationSize = Math.max(30, Math.floor(samples.length * 0.35));
      const validation = samples.slice(0, validationSize);
      const training = samples.slice(validationSize);
      const minTrainingSample = Math.max(25, Math.floor(training.length * 0.3));
      const minValidationSample = Math.max(12, Math.floor(validation.length * 0.25));

      const avgBuys = training.map((r) => r.totalBoughtSol / r.walletCount);
      const liqRatios = training.map((r) => r.marketCapUsd > 0 ? r.liquidityUsd / r.marketCapUsd : 0);
      const liquidities = training.map((r) => r.liquidityUsd);
      const scores = training.map((r) => r.score);

      const scoreChoices = uniqueSorted([
        BASE.minScore,
        Math.round(quantile(scores, 0.25)),
        Math.round(quantile(scores, 0.4)),
        Math.round(quantile(scores, 0.55)),
        Math.round(quantile(scores, 0.7)),
      ]).filter((v) => v >= BASE.minScore && v <= Math.max(BASE.minScore, 80));

      const buyChoices = uniqueSorted([
        BASE.minAvgBuyPerWallet,
        0.75,
        1,
        Number(quantile(avgBuys, 0.35).toFixed(2)),
        Number(quantile(avgBuys, 0.5).toFixed(2)),
      ]).filter((v) => v >= BASE.minAvgBuyPerWallet && v <= 5);

      const ratioChoices = uniqueSorted([
        BASE.minLiquidityToMcapRatio,
        0.08,
        0.1,
        Number(quantile(liqRatios, 0.35).toFixed(3)),
        Number(quantile(liqRatios, 0.5).toFixed(3)),
      ]).filter((v) => v >= BASE.minLiquidityToMcapRatio && v <= 0.5);

      const liquidityChoices = uniqueSorted([
        BASE.minLiquidityUsd,
        15_000,
        20_000,
        Math.round(quantile(liquidities, 0.35) / 1000) * 1000,
        Math.round(quantile(liquidities, 0.5) / 1000) * 1000,
      ]).filter((v) => v >= BASE.minLiquidityUsd && v <= 250_000);

      const baseTraining = metrics(training.filter((r) => passes(r, BASE)));
      const baseValidation = metrics(validation.filter((r) => passes(r, BASE)));
      let best: { thresholds: AdaptiveEntryThresholds; train: StrategyMetrics; validation: StrategyMetrics; score: number } | null = null;

      for (const minScore of scoreChoices) {
        for (const minAvgBuyPerWallet of buyChoices) {
          for (const minLiquidityToMcapRatio of ratioChoices) {
            for (const minLiquidityUsd of liquidityChoices) {
              const thresholds = { minScore, minAvgBuyPerWallet, minLiquidityToMcapRatio, minLiquidityUsd };
              const trainMetrics = metrics(training.filter((r) => passes(r, thresholds)));
              if (trainMetrics.sample < minTrainingSample || trainMetrics.pnl <= 0) continue;

              const validationMetrics = metrics(validation.filter((r) => passes(r, thresholds)));
              if (validationMetrics.sample < minValidationSample || validationMetrics.pnl <= 0) continue;

              // Require a real improvement on both the selection and untouched validation samples.
              if (trainMetrics.profitFactor < Math.max(1.15, baseTraining.profitFactor + 0.08)) continue;
              if (validationMetrics.profitFactor < Math.max(1.1, baseValidation.profitFactor + 0.03)) continue;

              const score = candidateScore(trainMetrics, training.length) + candidateScore(validationMetrics, validation.length) * 1.5;
              if (!best || score > best.score) best = { thresholds, train: trainMetrics, validation: validationMetrics, score };
            }
          }
        }
      }

      if (best) {
        next = best.thresholds;
        reason =
          `validated adaptation from ${overall.sample} positions; ` +
          `train PF ${best.train.profitFactor.toFixed(2)} (${best.train.sample}), ` +
          `recent PF ${best.validation.profitFactor.toFixed(2)} (${best.validation.sample})`;
      } else {
        // When the total edge is weak, fail safely by becoming slightly more selective;
        // never loosen any baseline guardrail and never change exits automatically.
        if (overall.profitFactor < 1.3 || overall.pnl <= 0) {
          next.minScore = Math.max(BASE.minScore + 1, BASE.minScore);
          next.minAvgBuyPerWallet = Math.max(0.75, BASE.minAvgBuyPerWallet);
          next.minLiquidityToMcapRatio = Math.max(0.08, BASE.minLiquidityToMcapRatio);
          next.minLiquidityUsd = Math.max(15_000, BASE.minLiquidityUsd);
          reason =
            `weak edge safety profile from ${overall.sample} positions; ` +
            `PF ${overall.profitFactor.toFixed(2)}, win ${(overall.winRate * 100).toFixed(1)}%; no validated grid winner`;
        } else {
          reason = `baseline retained; no candidate beat it out-of-sample across ${overall.sample} positions`;
        }
      }
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

    console.log(
      `[adaptive-strategy] ${reason}; score>=${next.minScore}, ` +
      `avgBuy>=${next.minAvgBuyPerWallet} SOL, liq/mcap>=${(next.minLiquidityToMcapRatio * 100).toFixed(1)}%, ` +
      `liquidity>=${next.minLiquidityUsd}`
    );
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
  console.log('[adaptive-strategy] enabled; jointly optimizes guarded entries every 6h from paper trades only');
}
