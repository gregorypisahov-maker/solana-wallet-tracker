import { getSupabaseAdmin } from "../lib/supabase";

const DEFAULT_WINDOW = "14d";
const MAX_WINDOW_MS = 365 * 24 * 60 * 60_000;
const MIN_WINDOW_MS = 60 * 60_000;

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const PAPER_FEE_BPS = Math.min(
  5_000,
  Math.max(0, numberFromEnv("PAPER_FEE_BPS", 100))
);

export type AiPnlWindow = {
  label: string;
  milliseconds: number;
};

export type AiPnlClosedTrade = {
  size_sol: number | string | null;
  entry_price_usd: number | string | null;
  exit_price_usd: number | string | null;
  opened_at: string | null;
  closed_at: string | null;
};

export type AiPnlScoreboard = {
  windowLabel: string;
  since: string;
  feeBps: number;
  entries: number;
  exits: number;
  openPositions: number;
  pricedExits: number;
  unpricedExits: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  averageNetReturnPct: number | null;
  medianNetReturnPct: number | null;
  bestNetReturnPct: number | null;
  worstNetReturnPct: number | null;
  cumulativeNetPnlSol: number;
  averageHoldMinutes: number | null;
};

function n(value: unknown, fallback = Number.NaN): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function parseAiPnlWindow(input?: string | null): AiPnlWindow {
  const raw = String(input ?? DEFAULT_WINDOW).trim().toLowerCase();
  const normalized = /^\d+$/.test(raw) ? `${raw}d` : raw;
  const match = /^(\d+)(h|d)$/.exec(normalized);
  if (!match) {
    throw new Error("Invalid window. Use formats such as 24h, 14d, or 30d.");
  }

  const amount = Number(match[1]);
  const unitMs = match[2] === "h" ? 60 * 60_000 : 24 * 60 * 60_000;
  const milliseconds = amount * unitMs;
  if (!Number.isFinite(milliseconds) || milliseconds < MIN_WINDOW_MS || milliseconds > MAX_WINDOW_MS) {
    throw new Error("Window must be between 1h and 365d.");
  }

  return { label: `${amount}${match[2]}`, milliseconds };
}

export function calculateAiPnlScoreboard(input: {
  window: AiPnlWindow;
  nowMs: number;
  feeBps: number;
  entries: number;
  openPositions: number;
  closedTrades: AiPnlClosedTrade[];
}): AiPnlScoreboard {
  const feeBps = Math.min(5_000, Math.max(0, input.feeBps));
  const proceedsMultiplierAfterFriction = Math.max(0, 1 - feeBps / 10_000);
  const returns: number[] = [];
  const pnlValues: number[] = [];
  const holdMinutes: number[] = [];

  for (const trade of input.closedTrades) {
    const entryPrice = n(trade.entry_price_usd);
    const exitPrice = n(trade.exit_price_usd);
    const sizeSol = n(trade.size_sol);
    if (entryPrice > 0 && exitPrice >= 0 && sizeSol > 0) {
      const netMultiple = Math.max(0, (exitPrice / entryPrice) * proceedsMultiplierAfterFriction);
      const netReturnPct = (netMultiple - 1) * 100;
      returns.push(netReturnPct);
      pnlValues.push(sizeSol * (netMultiple - 1));
    }

    const openedAt = Date.parse(String(trade.opened_at ?? ""));
    const closedAt = Date.parse(String(trade.closed_at ?? ""));
    if (Number.isFinite(openedAt) && Number.isFinite(closedAt) && closedAt >= openedAt) {
      holdMinutes.push((closedAt - openedAt) / 60_000);
    }
  }

  const wins = returns.filter((value) => value > 0).length;
  const losses = returns.filter((value) => value <= 0).length;
  const pricedExits = returns.length;

  return {
    windowLabel: input.window.label,
    since: new Date(input.nowMs - input.window.milliseconds).toISOString(),
    feeBps,
    entries: input.entries,
    exits: input.closedTrades.length,
    openPositions: input.openPositions,
    pricedExits,
    unpricedExits: input.closedTrades.length - pricedExits,
    wins,
    losses,
    winRatePct: pricedExits ? (wins / pricedExits) * 100 : null,
    averageNetReturnPct: average(returns),
    medianNetReturnPct: median(returns),
    bestNetReturnPct: returns.length ? Math.max(...returns) : null,
    worstNetReturnPct: returns.length ? Math.min(...returns) : null,
    cumulativeNetPnlSol: pnlValues.reduce((sum, value) => sum + value, 0),
    averageHoldMinutes: average(holdMinutes),
  };
}

export async function loadAiPnlScoreboard(windowInput?: string | null): Promise<AiPnlScoreboard> {
  const window = parseAiPnlWindow(windowInput);
  const nowMs = Date.now();
  const since = new Date(nowMs - window.milliseconds).toISOString();
  const supabase = getSupabaseAdmin();

  const [closedResult, closedEntryCountResult, openResult] = await Promise.all([
    supabase
      .from("ai_discovery_trades")
      .select("size_sol,entry_price_usd,exit_price_usd,opened_at,closed_at")
      .gte("closed_at", since)
      .order("closed_at", { ascending: true })
      .limit(5_000),
    supabase
      .from("ai_discovery_trades")
      .select("id", { count: "exact", head: true })
      .gte("opened_at", since),
    supabase
      .from("ai_discovery_positions")
      .select("opened_at"),
  ]);

  const lookupError = closedResult.error ?? closedEntryCountResult.error ?? openResult.error;
  if (lookupError) throw new Error(`AI PnL lookup failed: ${lookupError.message}`);

  const openPositions = openResult.data ?? [];
  const openEntriesInWindow = openPositions.filter((row) => {
    const openedAt = Date.parse(String(row.opened_at ?? ""));
    return Number.isFinite(openedAt) && openedAt >= Date.parse(since);
  }).length;

  return calculateAiPnlScoreboard({
    window,
    nowMs,
    feeBps: PAPER_FEE_BPS,
    entries: Number(closedEntryCountResult.count ?? 0) + openEntriesInWindow,
    openPositions: openPositions.length,
    closedTrades: (closedResult.data ?? []) as AiPnlClosedTrade[],
  });
}

function signedPct(value: number | null): string {
  if (value == null) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function signedSol(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(5)} SOL`;
}

function holdLabel(minutes: number | null): string {
  if (minutes == null) return "N/A";
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

export function formatAiPnlTelegram(scoreboard: AiPnlScoreboard): string {
  const frictionPct = scoreboard.feeBps / 100;
  return [
    "💰 <b>AI DISCOVERY PAPER PNL</b>",
    "",
    `Window: <b>${scoreboard.windowLabel}</b>`,
    `Entries: <b>${scoreboard.entries}</b>`,
    `Exits: <b>${scoreboard.exits}</b>`,
    `Open positions: <b>${scoreboard.openPositions}</b>`,
    `Priced exits used: <b>${scoreboard.pricedExits}/${scoreboard.exits}</b>`,
    "",
    `Wins / losses: <b>${scoreboard.wins}W / ${scoreboard.losses}L</b>`,
    `Win rate: <b>${scoreboard.winRatePct == null ? "N/A" : `${scoreboard.winRatePct.toFixed(1)}%`}</b>`,
    `Average net return: <b>${signedPct(scoreboard.averageNetReturnPct)}</b>`,
    `Median net return: ${signedPct(scoreboard.medianNetReturnPct)}`,
    `Best / worst: ${signedPct(scoreboard.bestNetReturnPct)} / ${signedPct(scoreboard.worstNetReturnPct)}`,
    `Cumulative net PnL: <b>${signedSol(scoreboard.cumulativeNetPnlSol)}</b>`,
    `Average hold: ${holdLabel(scoreboard.averageHoldMinutes)}`,
    "",
    `Assumption: <b>${scoreboard.feeBps.toFixed(0)} bps (${frictionPct.toFixed(2)}%)</b> round-trip fees + slippage.`,
    "Uses recorded paper entry/exit prices only; no live prices or fabricated fills.",
    scoreboard.unpricedExits
      ? `⚠️ ${scoreboard.unpricedExits} closed trade(s) lacked valid recorded prices and were excluded from return metrics.`
      : "✅ Every closed trade in this window had recorded entry and exit prices.",
    "",
    "Usage: <code>/ai_pnl 14d</code>, <code>/ai_pnl 30d</code>, or <code>/ai_pnl 72h</code>.",
  ].join("\n");
}

export async function handleAiPnl(windowInput?: string | null): Promise<string> {
  return formatAiPnlTelegram(await loadAiPnlScoreboard(windowInput));
}

let lastLoggedHour: string | null = null;

export async function maybeLogAiPnlHourlySummary(): Promise<void> {
  const hourKey = new Date().toISOString().slice(0, 13);
  if (lastLoggedHour === hourKey) return;
  lastLoggedHour = hourKey;

  try {
    const scoreboard = await loadAiPnlScoreboard(DEFAULT_WINDOW);
    console.log(
      `[ai-discovery-trader] pnl window=${scoreboard.windowLabel} ` +
        `entries=${scoreboard.entries} exits=${scoreboard.exits} open=${scoreboard.openPositions} ` +
        `priced=${scoreboard.pricedExits} winRate=${scoreboard.winRatePct?.toFixed(1) ?? "NA"}% ` +
        `avgNet=${scoreboard.averageNetReturnPct?.toFixed(2) ?? "NA"}% ` +
        `median=${scoreboard.medianNetReturnPct?.toFixed(2) ?? "NA"}% ` +
        `best=${scoreboard.bestNetReturnPct?.toFixed(2) ?? "NA"}% ` +
        `worst=${scoreboard.worstNetReturnPct?.toFixed(2) ?? "NA"}% ` +
        `netPnlSol=${scoreboard.cumulativeNetPnlSol.toFixed(5)} ` +
        `avgHoldMin=${scoreboard.averageHoldMinutes?.toFixed(1) ?? "NA"} ` +
        `feeSlippageBps=${scoreboard.feeBps.toFixed(0)}`
    );
  } catch (error) {
    lastLoggedHour = null;
    console.warn(
      `[ai-discovery-trader] pnl summary unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
