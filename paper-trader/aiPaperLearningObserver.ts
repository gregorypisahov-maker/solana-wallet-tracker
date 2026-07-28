import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const MODEL_VERSION = "paper_learning_observer_v1_2026_07_28";
const MIN_TRADES = 20;
const LOOKBACK_TRADES = 500;
const RUN_EVERY_MS = 15 * 60_000;
let running = false;

type Trade = {
  id: number;
  pnl_sol: number | string;
  net_return_pct: number | string;
  exit_reason: string;
  entry_snapshot: Record<string, any> | null;
};

type Bucket = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  pnlSol: number;
  positiveReturnPct: number;
  negativeReturnPct: number;
  returnSumPct: number;
};

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scoreBand(score: number): string {
  if (score >= 92) return "score_92_plus";
  if (score >= 88) return "score_88_91";
  if (score >= 85) return "score_85_87";
  return "score_below_85";
}

function momentumBand(m5: number): string {
  if (m5 < 2) return "m5_0_2";
  if (m5 < 6) return "m5_2_6";
  if (m5 < 10) return "m5_6_10";
  return "m5_10_plus";
}

function liquidityBand(liquidity: number): string {
  if (liquidity < 50_000) return "liq_below_50k";
  if (liquidity < 100_000) return "liq_50k_100k";
  if (liquidity < 250_000) return "liq_100k_250k";
  return "liq_250k_plus";
}

function tradeSegments(trade: Trade): string[] {
  const snapshot = trade.entry_snapshot ?? {};
  const opportunity = snapshot.opportunity ?? {};
  const market = snapshot.market ?? {};
  const score = n(opportunity.score);
  const m5 = n(market.changeM5, n(opportunity.price_change_m5));
  const liquidity = n(market.liquidityUsd, n(opportunity.liquidity_usd));
  const regime = String(opportunity.regime ?? opportunity.market_regime ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");

  return [
    "all",
    scoreBand(score),
    momentumBand(m5),
    liquidityBand(liquidity),
    `regime_${regime || "unknown"}`,
    `${scoreBand(score)}__${momentumBand(m5)}`,
  ];
}

function add(bucket: Bucket, trade: Trade): void {
  const pnl = n(trade.pnl_sol);
  const returnPct = n(trade.net_return_pct);
  bucket.trades += 1;
  bucket.pnlSol += pnl;
  bucket.returnSumPct += returnPct;
  if (pnl > 0) {
    bucket.wins += 1;
    bucket.positiveReturnPct += returnPct;
  } else {
    bucket.losses += 1;
    bucket.negativeReturnPct += Math.abs(returnPct);
  }
}

function summarize(bucket: Bucket) {
  // Beta(1,1) posterior prevents tiny samples from looking certain.
  const posteriorWinRate = (bucket.wins + 1) / (bucket.trades + 2);
  const profitFactor = bucket.negativeReturnPct > 0
    ? bucket.positiveReturnPct / bucket.negativeReturnPct
    : bucket.positiveReturnPct > 0 ? 99 : 0;
  const avgReturnPct = bucket.trades > 0 ? bucket.returnSumPct / bucket.trades : 0;
  const confidence = Math.min(1, bucket.trades / 100);

  let label = "insufficient_sample";
  if (bucket.trades >= 20) {
    if (posteriorWinRate >= 0.62 && profitFactor >= 1.5 && avgReturnPct > 0) label = "promising";
    else if (posteriorWinRate <= 0.45 || profitFactor < 0.9 || avgReturnPct < 0) label = "weak";
    else label = "neutral";
  }

  return {
    trades: bucket.trades,
    wins: bucket.wins,
    losses: bucket.losses,
    posteriorWinRate: round(posteriorWinRate),
    avgReturnPct: round(avgReturnPct),
    totalPnlSol: round(bucket.pnlSol, 6),
    profitFactor: round(profitFactor),
    confidence: round(confidence),
    label,
  };
}

export async function runAiPaperLearningObserver(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { data, error } = await supabase
      .from("ai_discovery_trades")
      .select("id,pnl_sol,net_return_pct,exit_reason,entry_snapshot")
      .order("closed_at", { ascending: false })
      .limit(LOOKBACK_TRADES);
    if (error) throw new Error(error.message);

    const trades = (data ?? []) as Trade[];
    if (trades.length < MIN_TRADES) {
      console.log(`[ai-paper-learning] waiting for sample: ${trades.length}/${MIN_TRADES}`);
      return;
    }

    const buckets = new Map<string, Bucket>();
    for (const trade of trades) {
      for (const key of tradeSegments(trade)) {
        const bucket = buckets.get(key) ?? {
          key,
          trades: 0,
          wins: 0,
          losses: 0,
          pnlSol: 0,
          positiveReturnPct: 0,
          negativeReturnPct: 0,
          returnSumPct: 0,
        };
        add(bucket, trade);
        buckets.set(key, bucket);
      }
    }

    const segmentRows = [...buckets.values()]
      .map((bucket) => ({ key: bucket.key, ...summarize(bucket) }))
      .sort((a, b) => b.trades - a.trades);
    const overall = segmentRows.find((row) => row.key === "all");
    const promising = segmentRows.filter((row) => row.label === "promising" && row.key !== "all");
    const weak = segmentRows.filter((row) => row.label === "weak" && row.key !== "all");

    const summary = {
      mode: "paper_observer_only",
      note: "Learns from completed paper trades but cannot modify live trading or strategy settings.",
      overall,
      strongestSegments: promising.slice(0, 10),
      weakestSegments: weak.slice(0, 10),
    };

    const { data: run, error: runError } = await supabase
      .from("ai_paper_learning_runs")
      .insert({ model_version: MODEL_VERSION, sample_size: trades.length, summary })
      .select("id")
      .single();
    if (runError) throw new Error(runError.message);

    const rows = segmentRows.map((segment) => ({
      run_id: run.id,
      segment_key: segment.key,
      sample_size: segment.trades,
      metrics: segment,
    }));
    const { error: segmentError } = await supabase
      .from("ai_paper_learning_segments")
      .insert(rows);
    if (segmentError) throw new Error(segmentError.message);

    // Keep only the newest 100 runs to avoid unbounded growth.
    const { data: oldRuns } = await supabase
      .from("ai_paper_learning_runs")
      .select("id")
      .order("created_at", { ascending: false })
      .range(100, 1000);
    const oldIds = (oldRuns ?? []).map((row: any) => row.id);
    if (oldIds.length) await supabase.from("ai_paper_learning_runs").delete().in("id", oldIds);

    console.log(
      `[ai-paper-learning] learned from ${trades.length} trades; ` +
      `${promising.length} promising and ${weak.length} weak segment(s)`
    );
  } finally {
    running = false;
  }
}

export function startAiPaperLearningObserver(): void {
  console.log(`[ai-paper-learning] ${MODEL_VERSION} enabled in paper observer-only mode`);
  void runAiPaperLearningObserver().catch((error) =>
    console.error("[ai-paper-learning] initial run failed", error)
  );
  setInterval(
    () => void runAiPaperLearningObserver().catch((error) =>
      console.error("[ai-paper-learning] run failed", error)
    ),
    RUN_EVERY_MS
  );
}
