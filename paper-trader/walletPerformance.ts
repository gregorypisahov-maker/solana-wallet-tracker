// paper-trader/walletPerformance.ts
//
// Phase 2 — computes historical performance per monitored wallet and
// writes it to the wallet_performance table.
//
// MATCHING LOGIC (this is the trickiest part, documented carefully):
// alert_participants tells us which wallets were part of the consensus
// buying behind each alert (token_mint, wallet_address, alert_sent_at).
// paper_trades/paper_positions tell us how the PAPER TRADER's position
// on that token performed — but the paper trader doesn't record which
// wallets triggered any given position, and only ever holds one
// position per mint at a time.
//
// To connect a wallet's alert participation to a trade OUTCOME, we
// match each alert_participants row to the paper position on the same
// mint whose estimated entry time falls within a short window after
// the alert fired (the engine opens positions immediately after
// onAlert() is called, so entry time should be seconds-to-minutes
// after alert_sent_at, not longer).
//
// Not every alert an wallet participated in has a matching paper
// position — many alerts get skipped (halt active, max concurrent
// positions, entry filter rejection, price fetch failure). Those count
// toward alerts_count but not completed_trades, which is intentional:
// they still reflect the wallet's alert participation frequency.

import { getSupabaseAdmin } from '../lib/supabase';
import { loadPositions, PositionRecord } from './analytics';
import { computeTrustScore } from './trustScore';

const supabase = getSupabaseAdmin();

// How long after an alert fires we're willing to treat a paper position
// on the same mint as "the trade that alert produced." Generous enough
// to cover the immediate onAlert() call plus any retry/backoff delay.
const ENTRY_MATCH_WINDOW_MINUTES = 10;

interface AlertParticipantRow {
  token_mint: string;
  wallet_address: string;
  alert_sent_at: string;
}

interface WalletAggregate {
  address: string;
  alertsCount: number;
  matchedPositions: PositionRecord[];
  losingAlertCount: number; // alerts this wallet participated in whose matched position lost, OR whose token later showed a heavy loss
  lastActivityAt: string | null;
}

function withinMatchWindow(alertSentAt: string, entryTimeIso: string): boolean {
  const alertMs = new Date(alertSentAt).getTime();
  const entryMs = new Date(entryTimeIso).getTime();
  const diffMinutes = (entryMs - alertMs) / 60_000;
  // Entry should happen at or slightly after the alert, never before.
  return diffMinutes >= -0.5 && diffMinutes <= ENTRY_MATCH_WINDOW_MINUTES;
}

async function loadAllAlertParticipants(): Promise<AlertParticipantRow[]> {
  const { data, error } = await supabase
    .from('alert_participants')
    .select('token_mint, wallet_address, alert_sent_at')
    .order('alert_sent_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to load alert_participants: ${error.message}`);
  }

  return data ?? [];
}

function findMatchedPosition(
  row: AlertParticipantRow,
  positionsByMint: Map<string, PositionRecord[]>
): PositionRecord | null {
  const candidates = positionsByMint.get(row.token_mint);
  if (!candidates || candidates.length === 0) return null;

  // Find the candidate whose estimated entry time is closest to (but
  // not before) the alert, within the match window.
  let best: PositionRecord | null = null;
  let bestDiff = Infinity;

  for (const candidate of candidates) {
    if (!withinMatchWindow(row.alert_sent_at, candidate.estimatedEntryTime)) continue;
    const diff = Math.abs(
      new Date(candidate.estimatedEntryTime).getTime() - new Date(row.alert_sent_at).getTime()
    );
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }

  return best;
}

// A position counts as a "heavy loss / rug" for the rugged_or_heavy_loss
// count if it lost more than this fraction of the position size.
const HEAVY_LOSS_THRESHOLD_PCT = 0.5;

export async function computeAndStoreWalletPerformance(): Promise<{ walletsUpdated: number }> {
  const [participants, { positions }] = await Promise.all([
    loadAllAlertParticipants(),
    loadPositions(),
  ]);

  const positionsByMint = new Map<string, PositionRecord[]>();
  for (const p of positions) {
    const list = positionsByMint.get(p.mint) ?? [];
    list.push(p);
    positionsByMint.set(p.mint, list);
  }

  const aggregates = new Map<string, WalletAggregate>();

  for (const row of participants) {
    const agg = aggregates.get(row.wallet_address) ?? {
      address: row.wallet_address,
      alertsCount: 0,
      matchedPositions: [],
      losingAlertCount: 0,
      lastActivityAt: null,
    };

    agg.alertsCount += 1;

    if (!agg.lastActivityAt || new Date(row.alert_sent_at) > new Date(agg.lastActivityAt)) {
      agg.lastActivityAt = row.alert_sent_at;
    }

    const matched = findMatchedPosition(row, positionsByMint);
    if (matched) {
      agg.matchedPositions.push(matched);
      if (!matched.isWin) {
        agg.losingAlertCount += 1;
      }
    }

    aggregates.set(row.wallet_address, agg);
  }

  let walletsUpdated = 0;

  for (const agg of aggregates.values()) {
    const completedTrades = agg.matchedPositions.length;
    const wins = agg.matchedPositions.filter((p) => p.isWin).length;
    const losses = completedTrades - wins;
    const winRate = completedTrades > 0 ? wins / completedTrades : 0;

    const realizedPnlSol = agg.matchedPositions.reduce((sum, p) => sum + p.totalPnlSol, 0);

    const returns = agg.matchedPositions.map((p) => p.weightedExitMultiple - 1);
    const averageReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;

    const grossProfit = agg.matchedPositions
      .filter((p) => p.totalPnlSol > 0)
      .reduce((s, p) => s + p.totalPnlSol, 0);
    const grossLoss = Math.abs(
      agg.matchedPositions.filter((p) => p.totalPnlSol <= 0).reduce((s, p) => s + p.totalPnlSol, 0)
    );
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

    // Drawdown contribution: largest single losing position as a % of
    // this wallet's average position size, used as a simple proxy for
    // "how much damage has this wallet's worst call done."
    const avgPositionSizeSol =
      agg.matchedPositions.length > 0
        ? agg.matchedPositions.reduce((s, p) => s + p.totalSoldSizeSol, 0) / agg.matchedPositions.length
        : 0;
    const worstLossSol = Math.min(0, ...agg.matchedPositions.map((p) => p.totalPnlSol), 0);
    const maxDrawdownPct =
      avgPositionSizeSol > 0 ? Math.min(100, (Math.abs(worstLossSol) / avgPositionSizeSol) * 100) : 0;

    const ruggedOrHeavyLossCount = agg.matchedPositions.filter(
      (p) => p.totalPnlSol < 0 && Math.abs(p.totalPnlSol) >= p.totalSoldSizeSol * HEAVY_LOSS_THRESHOLD_PCT
    ).length;

    const avgEntryTimingMinutes =
      completedTrades > 0
        ? agg.matchedPositions.reduce((sum, p, idx) => {
            const row = participants.find(
              (r) => r.token_mint === p.mint && r.wallet_address === agg.address
            );
            if (!row) return sum;
            const diffMinutes =
              (new Date(p.estimatedEntryTime).getTime() - new Date(row.alert_sent_at).getTime()) / 60_000;
            return sum + diffMinutes;
          }, 0) / completedTrades
        : null;

    const losingAlertParticipationPct = agg.alertsCount > 0 ? agg.losingAlertCount / agg.alertsCount : 0;

    const { trustScore } = computeTrustScore({
      completedTrades,
      wins,
      losses,
      winRate,
      averageReturn,
      profitFactor,
      maxDrawdownPct,
      lastActivityAt: agg.lastActivityAt,
      losingAlertParticipationPct,
    });

    const { error } = await supabase.from('wallet_performance').upsert(
      {
        wallet_address: agg.address,
        alerts_count: agg.alertsCount,
        completed_trades: completedTrades,
        wins,
        losses,
        win_rate: Number(winRate.toFixed(4)),
        average_return: Number(averageReturn.toFixed(4)),
        realized_pnl_sol: Number(realizedPnlSol.toFixed(4)),
        profit_factor: profitFactor === null ? null : Number(profitFactor.toFixed(3)),
        max_drawdown: Number((maxDrawdownPct / 100).toFixed(4)),
        avg_entry_timing_minutes:
          avgEntryTimingMinutes === null ? null : Number(avgEntryTimingMinutes.toFixed(2)),
        rugged_or_heavy_loss_count: ruggedOrHeavyLossCount,
        losing_alert_participation_pct: Number(losingAlertParticipationPct.toFixed(4)),
        trust_score: trustScore,
        last_activity_at: agg.lastActivityAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'wallet_address' }
    );

    if (error) {
      console.error(`[wallet-performance] Failed to upsert ${agg.address}:`, error);
      continue;
    }

    walletsUpdated += 1;
  }

  console.log(`[wallet-performance] Updated ${walletsUpdated} wallets.`);
  return { walletsUpdated };
}

export async function getTrustScoresForWallets(
  addresses: string[]
): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();

  const { data, error } = await supabase
    .from('wallet_performance')
    .select('wallet_address, trust_score')
    .in('wallet_address', addresses);

  if (error) {
    console.error('[wallet-performance] Failed to batch-load trust scores:', error);
    return new Map();
  }

  const map = new Map<string, number>();
  for (const row of data ?? []) {
    map.set(row.wallet_address, Number(row.trust_score));
  }
  return map;
}

export interface WalletPerformanceRow {
  wallet_address: string;
  alerts_count: number;
  completed_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  average_return: number;
  realized_pnl_sol: number;
  profit_factor: number | null;
  max_drawdown: number;
  trust_score: number;
  last_activity_at: string | null;
}

export async function getWalletPerformance(walletAddress: string): Promise<WalletPerformanceRow | null> {
  const { data, error } = await supabase
    .from('wallet_performance')
    .select('*')
    .eq('wallet_address', walletAddress)
    .limit(1);

  if (error) throw new Error(`Failed to load wallet performance: ${error.message}`);

  return data?.[0] ?? null;
}

export async function getTopWallets(limit: number): Promise<WalletPerformanceRow[]> {
  const { data, error } = await supabase
    .from('wallet_performance')
    .select('*')
    .gt('completed_trades', 0)
    .order('trust_score', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load top wallets: ${error.message}`);

  return data ?? [];
}

export async function getBottomWallets(limit: number): Promise<WalletPerformanceRow[]> {
  const { data, error } = await supabase
    .from('wallet_performance')
    .select('*')
    .gt('completed_trades', 0)
    .order('trust_score', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to load bottom wallets: ${error.message}`);

  return data ?? [];
}
