// paper-trader/dailySummary.ts
import { sendTelegramAlert } from '../lib/telegram';
import { computeStats, formatStatsForTelegram } from './statsReporter';
import { getOpenPositions } from './engine';

let lastSummaryDate: string | null = null;

// Call this on a timer (e.g. every 10-15 min) — it only actually sends
// once per UTC day, at the configured hour.
export async function maybeSendDailySummary(hourUTC: number): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

  if (now.getUTCHours() !== hourUTC) return;
  if (lastSummaryDate === today) return;

  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stats = await computeStats(sinceIso);
  const openPositions = await getOpenPositions();

  let message = formatStatsForTelegram(stats, 'Daily summary (last 24h)');
  if (openPositions.length > 0) {
    message += `\n\nOpen positions (${openPositions.length}):\n`;
    message += openPositions.map((p) => `  ${p.tokenSymbol} (${(p.remainingPct * 100).toFixed(0)}% remaining)`).join('\n');
  }

  try {
    await sendTelegramAlert(message);
    lastSummaryDate = today;
  } catch (err) {
    console.error('[paper-trader] Daily summary send failed:', err);
  }
}
