// paper-trader/analytics.ts
//
// Phase 1 — paper trading analytics, computed at the POSITION level
// (grouping every partial sell that belongs to one entry into a single
// logical trade), not at the sell-event level.
//
// This is intentionally a separate module from statsReporter.ts.
// statsReporter.ts's existing daily report counts every row in
// paper_trades as one "trade" (a sell event) — that's left completely
// untouched so your existing daily Telegram report doesn't change
// meaning underneath you. Everything in this file answers a different,
// more precise question: "how did each POSITION perform, net of all its
// partial sells?"
//
// Grouping key: position_id (set by engine.ts going forward, or by
// scripts/backfillPositionIds.ts for historical rows). Rows with no
// position_id at all (backfill not yet run) are grouped as a last
// resort by mint+entry_price, with a console warning, so this module
// still works even if you haven't run the backfill script yet — but
// you should run it for correctness.

import { loadAllTradesRaw } from './storage';

export interface PositionRecord {
  positionId: string;
  mint: string;
  tokenSymbol: string;
  entryPrice: number;
  sellCount: number;
  totalPnlSol: number;
  totalSoldSizeSol: number;
  totalProceedsSol: number;
  weightedExitMultiple: number; // proceeds-weighted average multiple across all sells
  finalMultiple: number; // multiple of the LAST sell (best proxy for "how it ended")
  isWin: boolean;
  exitReasons: string[]; // in chronological order, e.g. ['ladder_1.3x', 'hard_stop_loss']
  finalExitReason: string;
  holdMinutes: number; // hold time of the final sell
  openedAt: string; // timestamp of first sell (proxy — we don't store true open time on trades)
  closedAt: string; // timestamp of last sell
  estimatedEntryTime: string; // back-calculated from the first sell's happened_at minus its hold_minutes —
  // this recovers the actual position open time even though it isn't stored directly on paper_trades
  entryAlert: {
    score: number;
    walletCount: number;
    marketCapUsd: number;
    liquidityUsd: number;
    totalBoughtSol: number;
  };
}

export interface GroupBucket {
  label: string;
  tradeCount: number;
  winRatePct: number;
  avgMultiple: number;
  totalPnlSol: number;
  avgPnlSol: number;
}

export interface AnalyticsSummary {
  totalCompletedPositions: number;
  currentBankrollSol: number;
  startingBankrollSol: number;
  totalPnlSol: number;
  returnPct: number;
  winRatePct: number;
  wins: number;
  losses: number;
  avgWinSol: number;
  avgLossSol: number;
  profitFactor: number | null; // null when there are no losses to divide by
  maxDrawdownSol: number;
  maxDrawdownPct: number;
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: { type: 'win' | 'loss' | 'none'; count: number };
  bestPosition: PositionRecord | null;
  worstPosition: PositionRecord | null;
  byExitReason: GroupBucket[];
  byScoreRange: GroupBucket[];
  byMarketCapRange: GroupBucket[];
  byWalletCountRange: GroupBucket[];
  byLiquidityRange: GroupBucket[];
  byHourOfDay: GroupBucket[];
  ungroupedRowWarningCount: number;
}

function fallbackGroupKey(row: any): string {
  return `fallback_${row.mint}::${row.entry_price}`;
}

/**
 * Groups raw paper_trades rows into PositionRecord[]. Exported on its
 * own so wallet performance (Phase 2) and Telegram commands (Phase 4)
 * can reuse it without recomputing full analytics each time.
 */
export async function loadPositions(): Promise<{
  positions: PositionRecord[];
  ungroupedRowWarningCount: number;
}> {
  const rawRows = await loadAllTradesRaw();

  let ungroupedRowWarningCount = 0;
  const groups = new Map<string, any[]>();

  for (const row of rawRows) {
    let key = row.position_id as string | null;

    if (!key) {
      key = fallbackGroupKey(row);
      ungroupedRowWarningCount += 1;
    }

    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  if (ungroupedRowWarningCount > 0) {
    console.warn(
      `[analytics] ${ungroupedRowWarningCount} paper_trades rows have no position_id — ` +
        `falling back to mint+entry_price grouping for them. Run scripts/backfillPositionIds.ts to fix this.`
    );
  }

  const positions: PositionRecord[] = [];

  for (const [key, rows] of groups.entries()) {
    const sorted = [...rows].sort(
      (a, b) => new Date(a.happened_at).getTime() - new Date(b.happened_at).getTime()
    );

    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const totalPnlSol = sorted.reduce((sum, r) => sum + Number(r.pnl_sol), 0);
    const totalSoldSizeSol = sorted.reduce((sum, r) => sum + Number(r.sold_size_sol), 0);
    const totalProceedsSol = sorted.reduce((sum, r) => sum + Number(r.proceeds_sol), 0);

    const weightedExitMultiple =
      totalSoldSizeSol > 0
        ? sorted.reduce((sum, r) => sum + Number(r.multiple) * Number(r.sold_size_sol), 0) /
          totalSoldSizeSol
        : 0;

    const entryAlert = first.entry_alert ?? {};

    const estimatedEntryTimeMs =
      new Date(first.happened_at).getTime() - Number(first.hold_minutes) * 60_000;

    positions.push({
      positionId: key,
      mint: first.mint,
      tokenSymbol: first.token_symbol,
      entryPrice: Number(first.entry_price),
      sellCount: sorted.length,
      totalPnlSol: Number(totalPnlSol.toFixed(4)),
      totalSoldSizeSol: Number(totalSoldSizeSol.toFixed(4)),
      totalProceedsSol: Number(totalProceedsSol.toFixed(4)),
      weightedExitMultiple: Number(weightedExitMultiple.toFixed(4)),
      finalMultiple: Number(last.multiple),
      isWin: totalPnlSol > 0,
      exitReasons: sorted.map((r) => r.reason),
      finalExitReason: last.reason,
      holdMinutes: Number(last.hold_minutes),
      openedAt: first.happened_at,
      closedAt: last.happened_at,
      estimatedEntryTime: new Date(estimatedEntryTimeMs).toISOString(),
      entryAlert: {
        score: Number(entryAlert.score ?? 0),
        walletCount: Number(entryAlert.walletCount ?? 0),
        marketCapUsd: Number(entryAlert.marketCapUsd ?? 0),
        liquidityUsd: Number(entryAlert.liquidityUsd ?? 0),
        totalBoughtSol: Number(entryAlert.totalBoughtSol ?? 0),
      },
    });
  }

  positions.sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());

  return { positions, ungroupedRowWarningCount };
}

function computeStreaks(positions: PositionRecord[]): {
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: { type: 'win' | 'loss' | 'none'; count: number };
} {
  let longestWin = 0;
  let longestLoss = 0;
  let runWin = 0;
  let runLoss = 0;

  for (const p of positions) {
    if (p.isWin) {
      runWin += 1;
      runLoss = 0;
    } else {
      runLoss += 1;
      runWin = 0;
    }
    longestWin = Math.max(longestWin, runWin);
    longestLoss = Math.max(longestLoss, runLoss);
  }

  let currentStreak: { type: 'win' | 'loss' | 'none'; count: number } = { type: 'none', count: 0 };
  if (positions.length > 0) {
    if (runWin > 0) currentStreak = { type: 'win', count: runWin };
    else if (runLoss > 0) currentStreak = { type: 'loss', count: runLoss };
  }

  return { longestWinStreak: longestWin, longestLossStreak: longestLoss, currentStreak };
}

function computeMaxDrawdown(positions: PositionRecord[], startingBankrollSol: number): {
  maxDrawdownSol: number;
  maxDrawdownPct: number;
} {
  let equity = startingBankrollSol;
  let peak = startingBankrollSol;
  let maxDrawdownSol = 0;

  for (const p of positions) {
    equity += p.totalPnlSol;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    maxDrawdownSol = Math.max(maxDrawdownSol, drawdown);
  }

  const maxDrawdownPct = peak > 0 ? (maxDrawdownSol / peak) * 100 : 0;

  return { maxDrawdownSol: Number(maxDrawdownSol.toFixed(4)), maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)) };
}

function bucketBy(positions: PositionRecord[], keyFn: (p: PositionRecord) => string): GroupBucket[] {
  const groups = new Map<string, PositionRecord[]>();

  for (const p of positions) {
    const key = keyFn(p);
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const buckets: GroupBucket[] = [];

  for (const [label, group] of groups.entries()) {
    const wins = group.filter((p) => p.isWin).length;
    const totalPnl = group.reduce((sum, p) => sum + p.totalPnlSol, 0);
    const avgMultiple = group.reduce((sum, p) => sum + p.weightedExitMultiple, 0) / group.length;

    buckets.push({
      label,
      tradeCount: group.length,
      winRatePct: Number(((wins / group.length) * 100).toFixed(1)),
      avgMultiple: Number(avgMultiple.toFixed(3)),
      totalPnlSol: Number(totalPnl.toFixed(4)),
      avgPnlSol: Number((totalPnl / group.length).toFixed(4)),
    });
  }

  return buckets.sort((a, b) => b.tradeCount - a.tradeCount);
}

function scoreRangeLabel(score: number): string {
  if (score < 60) return 'below 60';
  if (score < 70) return '60-69';
  if (score < 80) return '70-79';
  return '80+';
}

function marketCapRangeLabel(mcap: number): string {
  if (mcap < 50_000) return 'below $50k';
  if (mcap < 100_000) return '$50k-$100k';
  if (mcap < 250_000) return '$100k-$250k';
  if (mcap < 1_000_000) return '$250k-$1M';
  return 'above $1M';
}

function walletCountRangeLabel(count: number): string {
  if (count < 4) return '3';
  if (count <= 5) return '4-5';
  if (count <= 8) return '6-8';
  return '9+';
}

function liquidityRangeLabel(liq: number): string {
  if (liq < 25_000) return 'below $25k';
  if (liq < 50_000) return '$25k-$50k';
  if (liq < 100_000) return '$50k-$100k';
  return 'above $100k';
}

function hourOfDayLabel(iso: string): string {
  const hour = new Date(iso).getUTCHours();
  return `${hour.toString().padStart(2, '0')}:00 UTC`;
}

export async function computeAnalytics(
  startingBankrollSol: number,
  currentBankrollSol: number
): Promise<AnalyticsSummary> {
  const { positions, ungroupedRowWarningCount } = await loadPositions();

  const wins = positions.filter((p) => p.isWin);
  const losses = positions.filter((p) => !p.isWin);

  const totalPnlSol = positions.reduce((sum, p) => sum + p.totalPnlSol, 0);
  const returnPct = startingBankrollSol > 0 ? (totalPnlSol / startingBankrollSol) * 100 : 0;

  const avgWinSol = wins.length > 0 ? wins.reduce((s, p) => s + p.totalPnlSol, 0) / wins.length : 0;
  const avgLossSol = losses.length > 0 ? losses.reduce((s, p) => s + p.totalPnlSol, 0) / losses.length : 0;

  const grossProfit = wins.reduce((s, p) => s + p.totalPnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.totalPnlSol, 0));
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : null;

  const { maxDrawdownSol, maxDrawdownPct } = computeMaxDrawdown(positions, startingBankrollSol);
  const { longestWinStreak, longestLossStreak, currentStreak } = computeStreaks(positions);

  const sortedByPnl = [...positions].sort((a, b) => b.totalPnlSol - a.totalPnlSol);
  const bestPosition = sortedByPnl.length > 0 ? sortedByPnl[0] : null;
  const worstPosition = sortedByPnl.length > 0 ? sortedByPnl[sortedByPnl.length - 1] : null;

  return {
    totalCompletedPositions: positions.length,
    currentBankrollSol: Number(currentBankrollSol.toFixed(4)),
    startingBankrollSol: Number(startingBankrollSol.toFixed(4)),
    totalPnlSol: Number(totalPnlSol.toFixed(4)),
    returnPct: Number(returnPct.toFixed(2)),
    winRatePct: positions.length > 0 ? Number(((wins.length / positions.length) * 100).toFixed(1)) : 0,
    wins: wins.length,
    losses: losses.length,
    avgWinSol: Number(avgWinSol.toFixed(4)),
    avgLossSol: Number(avgLossSol.toFixed(4)),
    profitFactor,
    maxDrawdownSol,
    maxDrawdownPct,
    longestWinStreak,
    longestLossStreak,
    currentStreak,
    bestPosition,
    worstPosition,
    byExitReason: bucketBy(positions, (p) => p.finalExitReason),
    byScoreRange: bucketBy(positions, (p) => scoreRangeLabel(p.entryAlert.score)),
    byMarketCapRange: bucketBy(positions, (p) => marketCapRangeLabel(p.entryAlert.marketCapUsd)),
    byWalletCountRange: bucketBy(positions, (p) => walletCountRangeLabel(p.entryAlert.walletCount)),
    byLiquidityRange: bucketBy(positions, (p) => liquidityRangeLabel(p.entryAlert.liquidityUsd)),
    byHourOfDay: bucketBy(positions, (p) => hourOfDayLabel(p.closedAt)),
    ungroupedRowWarningCount,
  };
}
