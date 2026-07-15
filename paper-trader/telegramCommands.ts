// paper-trader/telegramCommands.ts
//
// Phase 4 — implementations of the /paperstats, /walletstats,
// /exitstats, /scorestats commands. Each function returns a formatted
// HTML string ready to hand to sendTelegramAlert(). Kept separate from
// the bot listener (worker/telegramBot.ts) so the formatting logic can
// be tested/reused independently of the polling loop.

import { config } from './config';
import { computeAnalytics } from './analytics';
import { loadState, loadOpenPositions, saveState } from './storage';
import { getTopWallets, getBottomWallets, WalletPerformanceRow } from './walletPerformance';
import { getSupabaseAdmin } from '../lib/supabase';
import { estimateHeliusCredits } from '../worker/heliusUsage';
import { evaluatePaperReadiness } from './readiness';

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

export async function handleHeliusStats(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from('monitor_usage_samples')
    .select(
      'period_started_at, recorded_at, signature_requests, transaction_requests, webhook_events, websocket_notifications, websocket_bytes, rate_limit_errors, rpc_failures, stored_trades, max_queue_depth, mode'
    )
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to load Helius usage: ${error.message}`);
  }

  if (!data?.length) {
    return [
      '⚡ <b>HELIUS USAGE</b>',
      '',
      'No monitor usage sample has been saved yet.',
      'The first sample is written within 15 minutes of deployment.',
    ].join('\n');
  }

  const latestMode = data[data.length - 1].mode ?? 'websocket';
  let currentModeStart = data.length - 1;
  while (
    currentModeStart > 0 &&
    (data[currentModeStart - 1].mode ?? 'websocket') === latestMode
  ) {
    currentModeStart -= 1;
  }
  const currentData = data.slice(currentModeStart);

  const totals = currentData.reduce(
    (sum, row) => ({
      signatureRequests: sum.signatureRequests + Number(row.signature_requests),
      transactionRequests: sum.transactionRequests + Number(row.transaction_requests),
      webhookEvents: sum.webhookEvents + Number(row.webhook_events),
      websocketNotifications:
        sum.websocketNotifications + Number(row.websocket_notifications),
      websocketBytes: sum.websocketBytes + Number(row.websocket_bytes),
      rateLimitErrors: sum.rateLimitErrors + Number(row.rate_limit_errors),
      rpcFailures: sum.rpcFailures + Number(row.rpc_failures),
      storedTrades: sum.storedTrades + Number(row.stored_trades),
      maxQueueDepth: Math.max(sum.maxQueueDepth, Number(row.max_queue_depth)),
    }),
    {
      signatureRequests: 0,
      transactionRequests: 0,
      webhookEvents: 0,
      websocketNotifications: 0,
      websocketBytes: 0,
      rateLimitErrors: 0,
      rpcFailures: 0,
      storedTrades: 0,
      maxQueueDepth: 0,
    }
  );

  const estimatedCredits = estimateHeliusCredits(totals);
  const firstStartedAt = Date.parse(currentData[0].period_started_at);
  const lastRecordedAt = Date.parse(currentData[currentData.length - 1].recorded_at);
  const sampledHours = Math.max(
    0.25,
    (lastRecordedAt - firstStartedAt) / 3_600_000
  );
  const projectedDaily = (estimatedCredits / sampledHours) * 24;
  const projectedMonthly = projectedDaily * 30;

  return [
    '⚡ <b>HELIUS USAGE — BOT ESTIMATE</b>',
    '',
    `Mode: <b>${latestMode === 'webhook' ? 'Filtered SWAP webhook' : 'WebSocket fallback'}</b>`,
    `Sample: ${sampledHours.toFixed(1)} hours`,
    `Estimated credits: <b>${Math.round(estimatedCredits).toLocaleString()}</b>`,
    `Projected 30 days: <b>${Math.round(projectedMonthly).toLocaleString()}</b> / 1,000,000`,
    '',
    `Reconciliation calls: ${totals.signatureRequests.toLocaleString()}`,
    `Transaction lookups: ${totals.transactionRequests.toLocaleString()}`,
    `Filtered webhook events: ${totals.webhookEvents.toLocaleString()}`,
    `WebSocket events: ${totals.websocketNotifications.toLocaleString()}`,
    `Stored trades: ${totals.storedTrades.toLocaleString()}`,
    `429 errors: ${totals.rateLimitErrors}`,
    `RPC failures: ${totals.rpcFailures}`,
    `Maximum event queue: ${totals.maxQueueDepth}`,
    '',
    'Dashboard billing remains the final source of truth; streamed-byte billing is estimated.',
  ].join('\n');
}

export async function handleReadiness(): Promise<string> {
  const state = await loadState();
  const analytics = await computeAnalytics(
    config.position.simulatedBankrollSol,
    state.bankrollSol
  );
  const result = evaluatePaperReadiness({
    completedPositions: analytics.totalCompletedPositions,
    totalPnlSol: analytics.totalPnlSol,
    profitFactor: analytics.profitFactor,
    maxDrawdownPct: analytics.maxDrawdownPct,
    halted: state.halted,
  });

  const lines = [
    '🧪 <b>REAL-SOL READINESS GATE</b>',
    '',
    result.ready
      ? '🟢 Paper evidence gate passed.'
      : '🟡 Keep paper trading — the evidence gate has not passed yet.',
    '',
  ];

  for (const check of result.checks) {
    lines.push(
      `${check.passed ? '✅' : '❌'} <b>${check.label}</b>: ${check.actual} (target: ${check.target})`
    );
  }

  lines.push(
    '',
    'Passing this gate reduces uncertainty; it cannot guarantee future profit. Real trading remains disabled.'
  );

  return lines.join('\n');
}

export async function handleResume(): Promise<string> {
  const state = await loadState();

  const previousLosses = state.consecutiveLosses;
  const previousReason = state.haltReason;
  const wasHalted = state.halted || Boolean(state.haltReason) || state.consecutiveLosses > 0;

  state.halted = false;
  state.consecutiveLosses = 0;
  state.haltReason = null;

  await saveState(state);

  return [
    wasHalted ? '▶️ PAPER TRADING RESUMED' : '✅ PAPER TRADER IS ACTIVE',
    '',
    `Previous losses: ${previousLosses}`,
    `Previous reason: ${previousReason ?? 'Not recorded'}`,
    `Bankroll: ${state.bankrollSol.toFixed(4)} SOL`,
    '',
    'Monitoring: ACTIVE',
    'New paper entries: ENABLED',
  ].join('\n');
}
