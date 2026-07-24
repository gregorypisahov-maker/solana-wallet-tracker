import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

const supabase = getSupabaseAdmin();
const VERSION = "ai_discovery_trader_v1_2_2026_07_24";
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const ENTRY_FRICTION_PCT = 0.6;
const EXIT_FRICTION_PCT = 0.6;
const FIXED_SIZE_SOL = 0.1;
const MAX_DAILY_ENTRIES = 4;
const MAX_CONSECUTIVE_LOSSES = 3;
const DAILY_LOSS_LIMIT_SOL = 0.05;
const MIN_SCORE = 82;
const MAX_OPPORTUNITY_AGE_MS = 3 * 60_000;
const COOLDOWN_MS = 2 * 60 * 60_000;
const HARD_STOP_PCT = -6;
const TAKE_PROFIT_PCT = 10;
const TRAIL_ARM_PCT = 6;
const TRAIL_DISTANCE_PCT = 4;
const MAX_HOLD_MS = 45 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
let scanRunning = false;
let positionRunning = false;
let lastSummaryAt = 0;

type State = { enabled: boolean; halted: boolean; halt_reason: string | null; bankroll_sol: number | string; entries_today: number; daily_date: string; daily_realized_pnl_sol: number | string; consecutive_losses: number };
type Position = { position_id: string; mint: string; token_symbol: string; pair_address: string; entry_price_usd: number | string; last_price_usd: number | string; peak_price_usd: number | string; size_sol: number | string; opened_at: string; entry_snapshot: Record<string, unknown> };

function n(value: unknown, fallback = 0): number { const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function enabled(): boolean { const raw = process.env.ENABLE_AI_DISCOVERY_TRADER?.trim().toLowerCase(); return !raw || !["0", "false", "off", "no"].includes(raw); }
async function fetchJson(url: string): Promise<any> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); try { const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } }); if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return await response.json(); } finally { clearTimeout(timer); } }

async function priceFor(mint: string, pairAddress: string) {
  const body = await fetchJson(`${DEX_URL}/${encodeURIComponent(mint)}`);
  const pairs = Array.isArray(body) ? body : [];
  const pair = pairs.find((item: any) => item?.chainId === "solana" && String(item?.pairAddress ?? "") === pairAddress && item?.baseToken?.address === mint);
  if (!pair) return null;
  const priceUsd = n(pair?.priceUsd, NaN);
  const liquidityUsd = n(pair?.liquidity?.usd, NaN);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(liquidityUsd) || liquidityUsd < 25_000) return null;
  return { priceUsd, liquidityUsd, marketCapUsd: n(pair?.marketCap ?? pair?.fdv, 0), changeM5: n(pair?.priceChange?.m5, 0) };
}

async function loadState(): Promise<State> { const { data, error } = await supabase.from("ai_discovery_state").select("*").eq("id", 1).single(); if (error) throw new Error(error.message); return data as State; }
async function resetDay(state: State): Promise<State> { const today = new Date().toISOString().slice(0, 10); if (state.daily_date === today) return state; const { data, error } = await supabase.from("ai_discovery_state").update({ entries_today: 0, daily_date: today, daily_realized_pnl_sol: 0, consecutive_losses: 0, halted: false, halt_reason: null, updated_at: new Date().toISOString() }).eq("id", 1).select("*").single(); if (error) throw new Error(error.message); return data as State; }
async function loadPositions(): Promise<Position[]> { const { data, error } = await supabase.from("ai_discovery_positions").select("*").order("opened_at", { ascending: true }); if (error) throw new Error(error.message); return (data ?? []) as Position[]; }
async function cooledDown(mint: string): Promise<boolean> { const cutoff = new Date(Date.now() - COOLDOWN_MS).toISOString(); const { data, error } = await supabase.from("ai_discovery_trades").select("id").eq("mint", mint).gte("closed_at", cutoff).limit(1); if (error) throw new Error(error.message); return Boolean(data?.length); }

async function maybeSummary(): Promise<void> { if (Date.now() - lastSummaryAt < 30 * 60_000) return; lastSummaryAt = Date.now(); const { data } = await supabase.from("market_opportunities").select("token_symbol,score,status,market_regime,reasons,risks,last_seen_at").order("score", { ascending: false }).limit(3); if (!data?.length) return; const lines = data.map((row: any, index: number) => `${index + 1}. <b>${row.token_symbol}</b> — ${row.score}/100 · ${row.status}\n${(row.reasons ?? []).slice(0, 2).join(", ")}${row.risks?.length ? ` · risk: ${row.risks.slice(0, 1).join(", ")}` : ""}`); await sendTelegramAlert(["🧠 <b>AI MARKET DISCOVERY UPDATE</b>", `Regime: <b>${data[0]?.market_regime ?? "unknown"}</b>`, "", ...lines, "", "Paper execution only."].join("\n")); }

async function openTrade(state: State, opportunity: any, market: any): Promise<void> { const sizeSol = Math.min(FIXED_SIZE_SOL, n(state.bankroll_sol)); if (sizeSol < FIXED_SIZE_SOL) return; const now = new Date().toISOString(); const positionId = `ai_${randomUUID()}`; const snapshot = { version: VERSION, opportunity, market, friction: { entryPct: ENTRY_FRICTION_PCT, exitPct: EXIT_FRICTION_PCT } }; const { error } = await supabase.from("ai_discovery_positions").insert({ position_id: positionId, mint: opportunity.mint, token_symbol: opportunity.token_symbol, pair_address: opportunity.pair_address, entry_price_usd: market.priceUsd, last_price_usd: market.priceUsd, peak_price_usd: market.priceUsd, size_sol: sizeSol, opened_at: now, last_checked_at: now, entry_snapshot: snapshot, updated_at: now }); if (error) throw new Error(error.message); await supabase.from("ai_discovery_state").update({ bankroll_sol: n(state.bankroll_sol) - sizeSol, entries_today: state.entries_today + 1, last_entry_at: now, last_scan_at: now, updated_at: now }).eq("id", 1); await sendTelegramAlert(["🧠⚡ <b>AI DISCOVERY PAPER TRADE OPENED</b>", "", `Token: <b>${opportunity.token_symbol}</b>`, `Score: <b>${opportunity.score}/100</b>`, `Size: <b>${sizeSol.toFixed(3)} SOL</b>`, `Liquidity: <b>$${Math.round(market.liquidityUsd).toLocaleString()}</b>`, `Reasons: ${(opportunity.reasons ?? []).slice(0, 3).join(", ")}`, "", `<a href=\"https://dexscreener.com/solana/${opportunity.pair_address}\">Open chart</a>`, "", "🧪 Paper only — no real SOL used."].join("\n")); }

async function scanEntries(): Promise<void> {
  if (scanRunning) return; scanRunning = true;
  try {
    const state = await resetDay(await loadState()); const now = new Date().toISOString();
    await supabase.from("ai_discovery_state").update({ last_scan_at: now, updated_at: now }).eq("id", 1);
    await maybeSummary().catch((error) => console.warn("[ai-discovery-trader] summary failed", error));
    if (!state.enabled || state.halted) return;
    if (state.entries_today >= MAX_DAILY_ENTRIES || n(state.daily_realized_pnl_sol) <= -DAILY_LOSS_LIMIT_SOL || state.consecutive_losses >= MAX_CONSECUTIVE_LOSSES) { const reason = state.entries_today >= MAX_DAILY_ENTRIES ? "daily_entry_limit" : n(state.daily_realized_pnl_sol) <= -DAILY_LOSS_LIMIT_SOL ? "daily_loss_limit" : "consecutive_loss_limit"; await supabase.from("ai_discovery_state").update({ halted: true, halt_reason: reason, updated_at: now }).eq("id", 1); return; }
    if ((await loadPositions()).length > 0) return;
    const cutoff = new Date(Date.now() - MAX_OPPORTUNITY_AGE_MS).toISOString();
    const { data, error } = await supabase.from("market_opportunities").select("*").eq("status", "armed").gte("score", MIN_SCORE).gte("last_seen_at", cutoff).order("score", { ascending: false }).limit(10);
    if (error) throw new Error(error.message);
    for (const opportunity of data ?? []) {
      if ((opportunity.risks ?? []).length > 1 || await cooledDown(opportunity.mint)) continue;
      try { const market = await priceFor(opportunity.mint, opportunity.pair_address); if (!market) { console.warn(`[ai-discovery-trader] skipped ${opportunity.token_symbol}: bound pair unavailable on DexScreener`); continue; } if (market.changeM5 < 0 || market.changeM5 > 15) continue; await openTrade(state, opportunity, market); break; } catch (error) { console.warn(`[ai-discovery-trader] candidate ${opportunity.token_symbol} skipped`, error); }
    }
  } finally { scanRunning = false; }
}

async function closeTrade(position: Position, market: any, reason: string, grossPct: number): Promise<void> { const exitMultiple = 1 + (grossPct - ENTRY_FRICTION_PCT - EXIT_FRICTION_PCT) / 100; const sizeSol = n(position.size_sol); const proceeds = Math.max(0, sizeSol * exitMultiple); const pnlSol = proceeds - sizeSol; const netPct = grossPct - ENTRY_FRICTION_PCT - EXIT_FRICTION_PCT; const now = new Date().toISOString(); const state = await loadState(); const { error } = await supabase.from("ai_discovery_trades").insert({ position_id: position.position_id, mint: position.mint, token_symbol: position.token_symbol, pair_address: position.pair_address, entry_price_usd: n(position.entry_price_usd), exit_price_usd: market.priceUsd, size_sol: sizeSol, gross_return_pct: grossPct, net_return_pct: netPct, pnl_sol: pnlSol, exit_reason: reason, opened_at: position.opened_at, closed_at: now, entry_snapshot: position.entry_snapshot, exit_snapshot: { version: VERSION, market, peakPriceUsd: n(position.peak_price_usd) } }); if (error) throw new Error(error.message); await supabase.from("ai_discovery_positions").delete().eq("position_id", position.position_id); const losses = pnlSol < 0 ? state.consecutive_losses + 1 : 0; await supabase.from("ai_discovery_state").update({ bankroll_sol: n(state.bankroll_sol) + proceeds, daily_realized_pnl_sol: n(state.daily_realized_pnl_sol) + pnlSol, consecutive_losses: losses, updated_at: now }).eq("id", 1); await sendTelegramAlert([`${pnlSol >= 0 ? "✅" : "🔴"} <b>AI DISCOVERY PAPER TRADE CLOSED</b>`, "", `Token: <b>${position.token_symbol}</b>`, `Exit: <b>${reason.replaceAll("_", " ")}</b>`, `Net: <b>${netPct >= 0 ? "+" : ""}${netPct.toFixed(2)}%</b>`, `PnL: <b>${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL</b>`, "", "🧪 Paper only."].join("\n")); }

async function managePositions(): Promise<void> {
  if (positionRunning) return; positionRunning = true;
  try {
    for (const position of await loadPositions()) {
      try {
        const heldMs = Date.now() - Date.parse(position.opened_at);
        const market = await priceFor(position.mint, position.pair_address);
        if (!market) {
          if (heldMs < MAX_HOLD_MS) { console.warn(`[ai-discovery-trader] position ${position.token_symbol} price unavailable; holding fail-closed`); continue; }
          const fallbackPrice = n(position.last_price_usd, n(position.entry_price_usd));
          const entry = n(position.entry_price_usd);
          const grossPct = (fallbackPrice / entry - 1) * 100;
          const fallbackMarket = { priceUsd: fallbackPrice, liquidityUsd: null, marketCapUsd: null, changeM5: null, source: "last_valid_price" };
          console.warn(`[ai-discovery-trader] position ${position.token_symbol} exceeded max hold with unavailable pair; closing at last valid price`);
          await closeTrade(position, fallbackMarket, "max_hold_price_unavailable", grossPct);
          continue;
        }
        const entry = n(position.entry_price_usd);
        const grossPct = (market.priceUsd / entry - 1) * 100;
        const peak = Math.max(n(position.peak_price_usd), market.priceUsd);
        const peakPct = (peak / entry - 1) * 100;
        const pullbackPct = (market.priceUsd / peak - 1) * 100;
        let reason: string | null = null;
        if (grossPct <= HARD_STOP_PCT) reason = "hard_stop";
        else if (grossPct >= TAKE_PROFIT_PCT) reason = "take_profit";
        else if (peakPct >= TRAIL_ARM_PCT && pullbackPct <= -TRAIL_DISTANCE_PCT) reason = "trailing_stop";
        else if (heldMs >= MAX_HOLD_MS) reason = "max_hold";
        if (reason) await closeTrade(position, market, reason, grossPct);
        else { const now = new Date().toISOString(); await supabase.from("ai_discovery_positions").update({ last_price_usd: market.priceUsd, peak_price_usd: peak, last_checked_at: now, updated_at: now }).eq("position_id", position.position_id); }
      } catch (error) { console.warn(`[ai-discovery-trader] position ${position.token_symbol} check skipped`, error); }
    }
  } finally { positionRunning = false; }
}

export function startAiDiscoveryTrader(): void { if (!enabled()) { console.log("[ai-discovery-trader] disabled by ENABLE_AI_DISCOVERY_TRADER"); return; } console.log(`[ai-discovery-trader] ${VERSION} enabled; paper-only; size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+`); void scanEntries().catch((error) => console.error("[ai-discovery-trader] initial scan failed", error)); void managePositions().catch((error) => console.error("[ai-discovery-trader] initial position check failed", error)); setInterval(() => void scanEntries().catch((error) => console.error("[ai-discovery-trader] scan failed", error)), 60_000); setInterval(() => void managePositions().catch((error) => console.error("[ai-discovery-trader] position check failed", error)), 10_000); }
