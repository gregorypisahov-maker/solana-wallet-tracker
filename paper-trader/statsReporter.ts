// paper-trader/statsReporter.ts
// Calculates paper-trading performance and sends one Telegram report per day.

import { config } from "./config";
import {
  loadTrades,
  loadState,
  loadOpenPositions,
} from "./storage";
import { sendTelegramAlert } from "../lib/telegram";
import { TradeRecord } from "./types";

export interface StatsSummary {
  totalSellEvents: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnlSol: number;
  avgWinSol: number;
  avgLossSol: number;
  avgHoldMinutes: number;
  cashBankrollSol: number;
  costBasisEquitySol: number;
  openPositionCount: number;
  bestTrade: TradeRecord | null;
  worstTrade: TradeRecord | null;
  reasonCounts: Record<string, number>;
}

let lastDailyReportKey: string | null = null;

export async function computeStats(
  sinceIso?: string
): Promise<StatsSummary> {
  const trades = await loadTrades(sinceIso);
  const state = await loadState();
  const openPositions = await loadOpenPositions();

  const wins = trades.filter((trade) => trade.pnlSol > 0);
  const losses = trades.filter((trade) => trade.pnlSol <= 0);

  const totalPnlSol = trades.reduce(
    (sum, trade) => sum + trade.pnlSol,
    0
  );

  const avgWinSol =
    wins.length > 0
      ? wins.reduce(
          (sum, trade) => sum + trade.pnlSol,
          0
        ) / wins.length
      : 0;

  const avgLossSol =
    losses.length > 0
      ? losses.reduce(
          (sum, trade) => sum + trade.pnlSol,
          0
        ) / losses.length
      : 0;

  const avgHoldMinutes =
    trades.length > 0
      ? trades.reduce(
          (sum, trade) => sum + trade.holdMinutes,
          0
        ) / trades.length
      : 0;

  const winRatePct =
    trades.length > 0
      ? (wins.length / trades.length) * 100
      : 0;

  const committedCapitalSol = Array.from(
    openPositions.values()
  ).reduce(
    (sum, position) =>
      sum +
      position.sizeSol * position.remainingPct,
    0
  );

  const costBasisEquitySol =
    state.bankrollSol + committedCapitalSol;

  const sortedTrades = [...trades].sort(
    (a, b) => b.pnlSol - a.pnlSol
  );

  const bestTrade =
    sortedTrades.length > 0
      ? sortedTrades[0]
      : null;

  const worstTrade =
    sortedTrades.length > 0
      ? sortedTrades[sortedTrades.length - 1]
      : null;

  const reasonCounts: Record<string, number> = {};

  for (const trade of trades) {
    reasonCounts[trade.reason] =
      (reasonCounts[trade.reason] ?? 0) + 1;
  }

  return {
    totalSellEvents: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct,
    totalPnlSol,
    avgWinSol,
    avgLossSol,
    avgHoldMinutes,
    cashBankrollSol: state.bankrollSol,
    costBasisEquitySol,
    openPositionCount: openPositions.size,
    bestTrade,
    worstTrade,
    reasonCounts,
  };
}

function signedSol(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(
    3
  )} SOL`;
}

function formatTradeLine(
  trade: TradeRecord | null
): string {
  if (!trade) {
    return "None";
  }

  const percentage =
    (trade.multiple - 1) * 100;

  return (
    `${trade.tokenSymbol}: ` +
    `${percentage >= 0 ? "+" : ""}` +
    `${percentage.toFixed(1)}% ` +
    `(${signedSol(trade.pnlSol)})`
  );
}

function formatExitReasons(
  reasonCounts: Record<string, number>
): string {
  const entries = Object.entries(reasonCounts);

  if (entries.length === 0) {
    return "None";
  }

  return entries
    .map(
      ([reason, count]) =>
        `• ${reason}: ${count}`
    )
    .join("\n");
}

export function formatDailyReport(
  daily: StatsSummary,
  allTime: StatsSummary
): string {
  const startingBankroll =
    config.position.simulatedBankrollSol;

  const allTimeReturnPct =
    startingBankroll > 0
      ? (allTime.totalPnlSol /
          startingBankroll) *
        100
      : 0;

  return (
    `📊 DAILY PAPER TRADING REPORT\n\n` +

    `LAST 24 HOURS\n` +
    `Closed sell events: ${daily.totalSellEvents}\n` +
    `Wins: ${daily.wins}\n` +
    `Losses: ${daily.losses}\n` +
    `Win rate: ${daily.winRatePct.toFixed(1)}%\n` +
    `PnL: ${signedSol(daily.totalPnlSol)}\n` +
    `Average win: ${signedSol(daily.avgWinSol)}\n` +
    `Average loss: ${signedSol(daily.avgLossSol)}\n` +
    `Average hold: ${daily.avgHoldMinutes.toFixed(1)} minutes\n\n` +

    `BEST / WORST\n` +
    `Best: ${formatTradeLine(daily.bestTrade)}\n` +
    `Worst: ${formatTradeLine(daily.worstTrade)}\n\n` +

    `CURRENT ACCOUNT\n` +
    `Cash bankroll: ${daily.cashBankrollSol.toFixed(3)} SOL\n` +
    `Equity at cost: ${daily.costBasisEquitySol.toFixed(3)} SOL\n` +
    `Open positions: ${daily.openPositionCount}\n\n` +

    `ALL-TIME\n` +
    `Sell events: ${allTime.totalSellEvents}\n` +
    `Win rate: ${allTime.winRatePct.toFixed(1)}%\n` +
    `Total PnL: ${signedSol(allTime.totalPnlSol)}\n` +
    `Return: ${allTimeReturnPct >= 0 ? "+" : ""}${allTimeReturnPct.toFixed(1)}%\n\n` +

    `EXIT REASONS — LAST 24 HOURS\n` +
    `${formatExitReasons(daily.reasonCounts)}`
  );
}

export async function sendDailyPaperReportIfDue(): Promise<void> {
  const now = new Date();
  const reportHourUtc =
    config.telegram.dailySummaryHourUTC;

  if (now.getUTCHours() !== reportHourUtc) {
    return;
  }

  const reportKey = now
    .toISOString()
    .slice(0, 10);

  if (lastDailyReportKey === reportKey) {
    return;
  }

  lastDailyReportKey = reportKey;

  try {
    const last24HoursIso = new Date(
      now.getTime() - 24 * 60 * 60 * 1000
    ).toISOString();

    const [dailyStats, allTimeStats] =
      await Promise.all([
        computeStats(last24HoursIso),
        computeStats(),
      ]);

    await sendTelegramAlert(
      formatDailyReport(
        dailyStats,
        allTimeStats
      )
    );

    console.log(
      `[paper-trader] Daily report sent for ${reportKey}`
    );
  } catch (error) {
    lastDailyReportKey = null;

    console.error(
      "[paper-trader] Daily report failed:",
      error
    );
  }
}
