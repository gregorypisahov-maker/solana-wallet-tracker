// paper-trader/telegramCommands.ts
//
// Phase 4 — implementations of the /paperstats, /walletstats,
// /exitstats, /scorestats commands. Each function returns a formatted
// HTML string ready to hand to sendTelegramAlert(). Kept separate from
// the bot listener (worker/telegramBot.ts) so the formatting logic can
// be tested/reused independently of the polling loop.

import { config } from './config';
import { computeAnalytics } from './analytics';
import { loadState, loadOpenPositions } from './storage';
import { getTopWallets, getBottomWallets, WalletPerformanceRow } from './walletPerformance';

function signedSol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)} SOL`;
}

function signedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export async function handlePaperStats(): Promise<string> {
  const state = await loadState();
  const openPositions = await loadOpenPositions();

  const analytics = await computeAnalytics(
    config.position.simulatedBankrollSol,
    state.bankrollSol
  );

  const lines = [
    '📊 <b>PAPER TRADING STATS</b>',
    '',
    `Bankroll (cash): <b>${state.bankrollSol.toFixed(3)} SOL</b>`,
    `Starting bankroll: ${analytics.startingBankrollSol.toFixed(3)} SOL`,
    `Total PnL: <b>${signedSol(analytics.totalPnlSol)}</b>`,
    `Return: <b>${signedPct(analytics.returnPct)}</b>`,
    '',
    `Completed positions: ${analytics.totalCompletedPositions}`,
    `Win rate: ${analytics.winRatePct.toFixed(1)}% (${analytics.wins}W / ${analytics.losses}L)`,
    `Profit factor: ${analytics.profitFactor === null ? 'N/A (no losses yet)' : analytics.profitFactor.toFixed(2)}`,
    `Max drawdown: ${analytics.maxDrawdownSol.toFixed(3)} SOL (${analytics.maxDrawdownPct.toFixed(1)}%)`,
    '',
    `Open positions: ${openPositions.size}`,
    `Current consecutive losses: ${state.consecutiveLosses}`,
    `Trading halted: ${state.halted ? `🔴 YES — ${state.haltReason ?? 'unknown reason'}` : '🟢 No'}`,
  ];

  if (analytics.ungroupedRowWarningCount > 0) {
    lines.push(
      '',
      `⚠️ ${analytics.ungroupedRowWarningCount} trade rows are grouped by a fallback method — run the position_id backfill script for full accuracy.`
    );
  }

  return lines.join('\n');
}

export async function handleWalletStats(): Promise<string> {
  const [top, bottom] = await Promise.all([getTopWallets(5), getBottomWallets(5)]);

  function formatWalletLine(w: WalletPerformanceRow): string {
    const short = `${w.wallet_address.slice(0, 4)}…${w.wallet_address.slice(-4)}`;
    return (
      `<code>${short}</code> — trust ${w.trust_score.toFixed(0)}/100, ` +
      `${w.completed_trades} trades, ${(w.win_rate * 100).toFixed(0)}% win, ` +
      `${signedPct(w.average_return * 100)} avg`
    );
  }

  const lines = ['👛 <b>WALLET PERFORMANCE</b>', ''];

  lines.push('<b>Top 5</b>');
  if (top.length === 0) {
    lines.push('No wallets with completed trades yet.');
  } else {
    for (const w of top) lines.push(formatWalletLine(w));
  }

  lines.push('', '<b>Bottom 5</b>');
  if (bottom.length === 0) {
    lines.push('No wallets with completed trades yet.');
  } else {
    for (const w of bottom) lines.push(formatWalletLine(w));
  }

  return lines.join('\n');
}

export async function handleExitStats(): Promise<string> {
  const state = await loadState();
  const analytics = await computeAnalytics(config.position.simulatedBankrollSol, state.bankrollSol);

  const lines = ['🚪 <b>PERFORMANCE BY EXIT REASON</b>', ''];

  if (analytics.byExitReason.length === 0) {
    lines.push('No completed positions yet.');
    return lines.join('\n');
  }

  for (const bucket of analytics.byExitReason) {
    lines.push(
      `<b>${bucket.label}</b>: ${bucket.tradeCount} trades, ` +
        `${bucket.winRatePct.toFixed(0)}% win, ` +
        `avg ${bucket.avgMultiple.toFixed(2)}x, ` +
        `total ${signedSol(bucket.totalPnlSol)}`
    );
  }

  return lines.join('\n');
}

export async function handleScoreStats(): Promise<string> {
  const state = await loadState();
  const analytics = await computeAnalytics(config.position.simulatedBankrollSol, state.bankrollSol);

  const lines = ['⭐ <b>PERFORMANCE BY SCORE RANGE</b>', ''];

  if (analytics.byScoreRange.length === 0) {
    lines.push('No completed positions yet.');
    return lines.join('\n');
  }

  const order = ['80+', '70-79', '60-69', 'below 60'];
  const sorted = [...analytics.byScoreRange].sort(
    (a, b) => order.indexOf(a.label) - order.indexOf(b.label)
  );

  for (const bucket of sorted) {
    lines.push(
      `<b>Score ${bucket.label}</b>: ${bucket.tradeCount} trades, ` +
        `${bucket.winRatePct.toFixed(0)}% win, ` +
        `avg ${bucket.avgMultiple.toFixed(2)}x, ` +
        `total ${signedSol(bucket.totalPnlSol)}`
    );
  }

  return lines.join('\n');
}
