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
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.pnl, 0));

  return {
    sample: rows.length,
    pnl: rows.reduce((sum, row) => sum + row.pnl, 0),
    winRate: rows.length ? wins.length / rows.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9.99 : 0,
  };
}

function validThreshold(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

async function applyManualOverride(): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('adaptive_strategy_state')
    .select('enabled,min_score,min_avg_buy_per_wallet,min_liquidity_to_mcap_ratio,min_liquidity_usd,reason')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const reason = String(data?.reason ?? '');
  if (!data?.enabled || !reason.startsWith('Manual safety correction:')) return false;

  const minScore = validThreshold(data.min_score, BASE.minScore, 100);
  const minAvgBuyPerWallet = validThreshold(data.min_avg_buy_per_wallet, BASE.minAvgBuyPerWallet, 10);
  const minLiquidityToMcapRatio = validThreshold(
    data.min_liquidity_to_mcap_ratio,
    BASE.minLiquidityToMcapRatio,
    0.75,
  );
  const minLiquidityUsd = validThreshold(data.min_liquidity_usd, BASE.minLiquidityUsd, 1_000_000);

  if (
    minScore === null ||
    minAvgBuyPerWallet === null ||
    minLiquidityToMcapRatio === null ||
    minLiquidityUsd === null
  ) {
    throw new Error('manual adaptive thresholds are malformed');
  }

  current = {
    minScore,
    minAvgBuyPerWallet,
    minLiquidityToMcapRatio,
    minLiquidityUsd,
  };

  console.log(
    `[adaptive-strategy] manual override loaded; score>=${current.minScore}, ` +
      `avgBuy>=${current.minAvgBuyPerWallet} SOL, ` +
      `liq/mcap>=${(current.minLiquidityToMcapRatio * 100).toFixed(1)}%, ` +
      `liquidity>=${current.minLiquidityUsd}`,
  );
  return true;
}

export async function learnAdaptiveStrategy(): Promise<void> {
  if (running) return;
  running = true;

  try {
    // A database correction must affect the running worker. Previously the row
    // changed in Supabase while this module kept stale thresholds in memory.
    if (await applyManualOverride()) return;

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

    // Keep automatic changes conservative. The former grid search selected a
    // narrow historical subset and raised the live liquidity ratio to 21.4%,
    // which stopped normal paper-data collection.
    const next: AdaptiveEntryThresholds =
      overall.sample >= 80 && (overall.profitFactor < 1.3 || overall.pnl <= 0)
        ? {
            minScore: Math.max(20, BASE.minScore),
            minAvgBuyPerWallet: Math.max(1.5, BASE.minAvgBuyPerWallet),
            minLiquidityToMcapRatio: Math.max(0.12, BASE.minLiquidityToMcapRatio),
            minLiquidityUsd: Math.max(15_000, BASE.minLiquidityUsd),
          }
        : { ...BASE };

    current = next;
    const reason =
      overall.sample >= 80 && (overall.profitFactor < 1.3 || overall.pnl <= 0)
        ? `conservative weak-edge profile from ${overall.sample} positions; PF ${overall.profitFactor.toFixed(2)}`
        : `baseline retained from ${overall.sample} positions`;

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
        `avgBuy>=${next.minAvgBuyPerWallet} SOL, ` +
        `liq/mcap>=${(next.minLiquidityToMcapRatio * 100).toFixed(1)}%, ` +
        `liquidity>=${next.minLiquidityUsd}`,
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
  console.log('[adaptive-strategy] enabled; refreshes guarded entries every 6h from paper trades only');
}
