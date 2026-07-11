// paper-trader/statsReporter.ts
import { loadTrades, loadState } from './storage';

export interface StatsSummary {
  totalSellEvents: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnlSol: number;
  avgWinSol: number;
  avgLossSol: number;
  bankrollSol: number;
  reasonCounts: Record<string, number>;
}

export async function computeStats(sinceIso?: string): Promise<StatsSummary | null> {
  const trades = await loadTrades(sinceIso);
  const state = await loadState();

  if (trades.length === 0) return null;

  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol <= 0);
  const totalPnlSol = trades.reduce((sum, t) => sum + t.pnlSol, 0);
  const avgWinSol = wins.length ? wins.reduce((s, t) => s + t.pnlSol, 0) / wins.length : 0;
  const avgLossSol = losses.length ? losses.reduce((s, t) => s + t.pnlSol, 0) / losses.length : 0;
  const winRatePct = (wins.length / trades.length) * 100;

  const reasonCounts: Record<string, number> = {};
  for (const t of trades) {
    reasonCounts[t.reason] = (reasonCounts[t.reason] || 0) + 1;
  }

  return {
    totalSellEvents: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct,
    totalPnlSol,
    avgWinSol,
    avgLossSol,
    bankrollSol: state.bankrollSol,
    reasonCounts,
  };
}

export function formatStatsForTelegram(stats: StatsSummary | null, label: string): string {
  if (!stats) {
    return `📊 [PAPER TRADER] ${label}\nNo trades closed in this period.`;
  }
  const reasonLines = Object.entries(stats.reasonCounts)
    .map(([reason, count]) => `  ${reason}: ${count}`)
    .join('\n');

  return (
    `📊 [PAPER TRADER] ${label}\n` +
    `Win rate: ${stats.winRatePct.toFixed(1)}% (${stats.wins}W / ${stats.losses}L)\n` +
    `Total PnL: ${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(3)} SOL\n` +
    `Avg win: ${stats.avgWinSol.toFixed(3)} SOL | Avg loss: ${stats.avgLossSol.toFixed(3)} SOL\n` +
    `Bankroll: ${stats.bankrollSol.toFixed(3)} SOL\n` +
    `Exit reasons:\n${reasonLines}`
  );
}

// CLI usage: tsx paper-trader/statsReporter.ts
if (require.main === module) {
  computeStats().then((stats) => {
    console.log(formatStatsForTelegram(stats, 'All-time report'));
    process.exit(0);
  });
}
