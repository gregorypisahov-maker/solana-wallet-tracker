import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";
import { conservativeSolProceeds, routeFeeSummary } from "./liveCostSimulation";
import { SCALP_RULES } from "./momentumScalperRules";
import { runMomentumScalperScan as runBaseMomentumScalperScan } from "./momentumScalperBase";

const supabase = getSupabaseAdmin();
export const STRATEGY_VERSION = "helius_jupiter_live_cost_v1_2026_08_04";
const SLIPPAGE_BPS = Math.min(200, Math.max(10, Number(process.env.SNIPER_SLIPPAGE_BPS || 200)));
let scanRunning = false;
let positionCheckRunning = false;

type Position = {
  position_id: string; mint: string; token_symbol: string; pair_address: string;
  entry_price_usd: number | string; entry_time: string; size_sol: number | string;
  peak_price_usd: number | string; entry_snapshot: Record<string, any>;
};

function n(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function envEnabled(name: string, fallback = true) { const v = process.env[name]?.trim().toLowerCase(); return v ? !["0", "false", "no", "off"].includes(v) : fallback; }
function interval(name: string, fallback: number, min: number, max: number) { return Math.min(max, Math.max(min, n(process.env[name], fallback))); }
const SCAN_INTERVAL_MS = interval("SCALP_SCAN_INTERVAL_MS", 60_000, 30_000, 300_000);
const POSITION_CHECK_INTERVAL_MS = interval("SCALP_POSITION_CHECK_MS", 1_000, 500, 60_000);

async function positions(): Promise<Position[]> {
  const { data, error } = await supabase.from("scalp_positions").select("*").order("entry_time");
  if (error) throw error;
  return (data || []) as Position[];
}

function exitReason(netPct: number, peakNetPct: number, ageSeconds: number): string | null {
  if (netPct <= -SCALP_RULES.hardStopLossPct) return "hard_stop";
  const giveback = peakNetPct >= SCALP_RULES.trailingHighPeakNetPct ? SCALP_RULES.trailingGivebackPctHigh : peakNetPct >= SCALP_RULES.trailingMidPeakNetPct ? SCALP_RULES.trailingGivebackPctMid : SCALP_RULES.trailingGivebackPctLow;
  if (peakNetPct >= SCALP_RULES.trailingActivationNetPct && netPct <= peakNetPct - giveback) return "trailing_stop";
  if (netPct >= SCALP_RULES.targetProfitPct) return "take_profit";
  const maxHold = peakNetPct >= SCALP_RULES.trailingActivationNetPct ? SCALP_RULES.runnerMaxHoldSeconds : SCALP_RULES.maxHoldSeconds;
  return ageSeconds >= maxHold ? "max_hold_time" : null;
}

async function blacklist(position: Position, netPct: number) {
  const hours = netPct <= -12 ? 24 * 7 : 4;
  await supabase.from("scalp_blacklist").upsert({ mint: position.mint, blacklisted_until: new Date(Date.now() + hours * 3_600_000).toISOString(), reason: `executable_hard_stop_${hours}h:${netPct.toFixed(2)}pct` }, { onConflict: "mint" });
}

export async function runMomentumScalperScan() { await runBaseMomentumScalperScan(); }

export async function checkMomentumScalpPositions(): Promise<void> {
  for (const position of await positions()) {
    try {
      const tokenRaw = String(position.entry_snapshot?.token_raw_amount || "");
      if (!/^\d+$/.test(tokenRaw) || BigInt(tokenRaw) <= 0n) {
        console.error(`[momentum-scalper] missing token_raw_amount for ${position.token_symbol}; refusing optimistic price exit`);
        continue;
      }
      const quote = await getJupiterQuote({ inputMint: position.mint, outputMint: JUPITER_SOL_MINT, rawTokenAmount: tokenRaw, slippageBps: SLIPPAGE_BPS });
      if (!quote.route || quote.outLamports <= 0n) continue;
      const proceedsSol = conservativeSolProceeds(quote);
      const sizeSol = n(position.size_sol);
      const netMultiple = sizeSol > 0 ? proceedsSol / sizeSol : 0;
      const netPct = (netMultiple - 1) * 100;
      const entryPrice = n(position.entry_price_usd, 1);
      const executableMark = entryPrice * netMultiple;
      const peakMark = Math.max(n(position.peak_price_usd, entryPrice), executableMark);
      const peakNetPct = ((peakMark / entryPrice) - 1) * 100;
      const nowMs = Date.now();
      const reason = exitReason(netPct, peakNetPct, Math.max(0, nowMs - Date.parse(position.entry_time)) / 1000);
      const now = new Date(nowMs).toISOString();

      if (!reason) {
        const { error } = await supabase.from("scalp_positions").update({ peak_price_usd: peakMark, last_price_usd: executableMark, last_checked_at: now, updated_at: now }).eq("position_id", position.position_id);
        if (error) throw error;
        continue;
      }

      const pnlSol = proceedsSol - sizeSol;
      const grossOutSol = Number(quote.outLamports) / 1_000_000_000;
      const grossReturnPct = ((grossOutSol / sizeSol) - 1) * 100;
      const exitSnapshot = {
        source: "jupiter_executable_quote", strategyVersion: STRATEGY_VERSION,
        token_raw_amount: tokenRaw, jupiter_quote: quote.raw,
        gross_quoted_out_sol: grossOutSol, conservative_net_proceeds_sol: proceedsSol,
        net_return_pct: netPct, peak_net_return_pct: peakNetPct,
        costs: routeFeeSummary(quote.raw),
        simulation_policy: "worst-case Jupiter threshold plus route-change, partial-fill, network, priority and Jito costs",
      };
      const { data, error } = await supabase.rpc("close_paper_scalp", {
        p_position_id: position.position_id, p_exit_price_usd: executableMark,
        p_gross_return_pct: grossReturnPct, p_net_return_pct: netPct,
        p_pnl_sol: pnlSol, p_proceeds_sol: proceedsSol, p_exit_reason: reason,
        p_closed_at: now, p_exit_snapshot: exitSnapshot,
      });
      if (error) throw error;
      if (reason === "hard_stop") await blacklist(position, netPct);
      console.log(`[JUPITER EXECUTABLE CLOSE] ${position.token_symbol} ${reason} net=${netPct.toFixed(2)}% pnl=${pnlSol.toFixed(6)} SOL`);
      try { await sendTelegramAlert(`${pnlSol >= 0 ? "✅" : "🔴"} <b>PAPER SNIPER CLOSED</b>\n\n🪙 <b>${position.token_symbol}</b>\nReason: <b>${reason.replaceAll("_", " ")}</b>\nNet after all modeled live costs: <b>${netPct.toFixed(2)}%</b>\nPaper PnL: <b>${pnlSol.toFixed(6)} SOL</b>\n\nStrategy: <b>${STRATEGY_VERSION}</b>`); } catch {}
      void data;
    } catch (error) { console.error(`[momentum-scalper] executable position check failed ${position.token_symbol}`, error); }
  }
}

async function scanSafely() { if (scanRunning) return; scanRunning = true; try { await runMomentumScalperScan(); } finally { scanRunning = false; } }
async function checkSafely() { if (positionCheckRunning) return; positionCheckRunning = true; try { await checkMomentumScalpPositions(); } finally { positionCheckRunning = false; } }

export function startMomentumScalperScheduler(): void {
  const discoveryEnabled = envEnabled("ENABLE_MOMENTUM_SCALPER", true);
  const managementEnabled = envEnabled("ENABLE_SNIPER_POSITION_MANAGER", true);
  console.log(`[momentum-scalper] ${STRATEGY_VERSION} discovery=${discoveryEnabled} management=${managementEnabled} check=${POSITION_CHECK_INTERVAL_MS}ms`);
  if (discoveryEnabled) { void scanSafely(); setInterval(() => void scanSafely(), SCAN_INTERVAL_MS); }
  if (managementEnabled) { void checkSafely(); setInterval(() => void checkSafely(), POSITION_CHECK_INTERVAL_MS); }
}
