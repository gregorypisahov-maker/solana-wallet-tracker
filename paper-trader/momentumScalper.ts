import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";
import {
  conservativeSolProceeds,
  expectedRoundTripCostPct,
  routeFeeSummary,
} from "./liveCostSimulation";
import { SCALP_RULES, SNIPER_MODE } from "./momentumScalperRules";
import { runMomentumScalperScan as runBaseMomentumScalperScan } from "./momentumScalperBase";

const supabase = getSupabaseAdmin();
export const STRATEGY_VERSION = "helius_jupiter_expected_cost_v2_2026_08_04";
const SLIPPAGE_BPS = Math.min(2_000, Math.max(10, Number(process.env.SNIPER_SLIPPAGE_BPS || 200)));
let scanRunning = false;
let positionCheckRunning = false;

type Position = {
  position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  entry_price_usd: number | string;
  entry_time: string;
  size_sol: number | string;
  peak_price_usd: number | string;
  entry_snapshot: Record<string, any>;
};

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envEnabled(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value ? !["0", "false", "no", "off"].includes(value) : fallback;
}

function interval(name: string, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n(process.env[name], fallback)));
}

const SCAN_INTERVAL_MS = interval("SCALP_SCAN_INTERVAL_MS", 60_000, 30_000, 300_000);
const POSITION_CHECK_INTERVAL_MS = interval("SCALP_POSITION_CHECK_MS", 1_000, 500, 60_000);

async function positions(): Promise<Position[]> {
  const { data, error } = await supabase.from("scalp_positions").select("*").order("entry_time");
  if (error) throw error;
  return (data || []) as Position[];
}

function exitReason(grossPct: number, peakGrossPct: number, ageSeconds: number): string | null {
  if (grossPct <= -SCALP_RULES.hardStopLossPct) return "hard_stop";
  if (
    peakGrossPct >= SCALP_RULES.trailingActivationGrossPct &&
    grossPct <= peakGrossPct - SCALP_RULES.trailingGivebackPct
  ) return "trailing_stop";
  if (grossPct >= SCALP_RULES.targetProfitPct) return "take_profit";

  const maxHold = SNIPER_MODE === "runner" && peakGrossPct >= SCALP_RULES.trailingActivationGrossPct
    ? SCALP_RULES.runnerMaxHoldSeconds
    : SCALP_RULES.maxHoldSeconds;
  return ageSeconds >= maxHold ? "max_hold_time" : null;
}

async function blacklist(position: Position, netPct: number): Promise<void> {
  const hours = netPct <= -12 ? 24 * 7 : 4;
  await supabase.from("scalp_blacklist").upsert({
    mint: position.mint,
    blacklisted_until: new Date(Date.now() + hours * 3_600_000).toISOString(),
    reason: `executable_hard_stop_${hours}h:${netPct.toFixed(2)}pct`,
  }, { onConflict: "mint" });
}

export async function runMomentumScalperScan(): Promise<void> {
  await runBaseMomentumScalperScan();
}

export async function checkMomentumScalpPositions(): Promise<void> {
  for (const position of await positions()) {
    try {
      const tokenRaw = String(position.entry_snapshot?.token_raw_amount || "");
      if (!/^\d+$/.test(tokenRaw) || BigInt(tokenRaw) <= 0n) {
        console.error(`[momentum-scalper] missing token_raw_amount for ${position.token_symbol}; refusing optimistic price exit`);
        continue;
      }

      const quote = await getJupiterQuote({
        inputMint: position.mint,
        outputMint: JUPITER_SOL_MINT,
        rawTokenAmount: tokenRaw,
        slippageBps: SLIPPAGE_BPS,
      });
      if (!quote.route || quote.outLamports <= 0n) continue;

      const sizeSol = n(position.size_sol);
      if (sizeSol <= 0) continue;

      const grossOutSol = Number(quote.outLamports) / 1_000_000_000;
      const grossMultiple = grossOutSol / sizeSol;
      const grossPct = (grossMultiple - 1) * 100;
      const entryPrice = n(position.entry_price_usd, 1);
      const grossMark = entryPrice * grossMultiple;
      const peakMark = Math.max(n(position.peak_price_usd, entryPrice), grossMark);
      const peakGrossPct = ((peakMark / entryPrice) - 1) * 100;
      const nowMs = Date.now();
      const ageSeconds = Math.max(0, nowMs - Date.parse(position.entry_time)) / 1_000;
      const reason = exitReason(grossPct, peakGrossPct, ageSeconds);
      const now = new Date(nowMs).toISOString();

      if (!reason) {
        const { error } = await supabase.from("scalp_positions").update({
          peak_price_usd: peakMark,
          last_price_usd: grossMark,
          last_checked_at: now,
          updated_at: now,
        }).eq("position_id", position.position_id);
        if (error) throw error;
        continue;
      }

      const proceedsSol = conservativeSolProceeds(quote, sizeSol);
      const netMultiple = proceedsSol / sizeSol;
      const netPct = (netMultiple - 1) * 100;
      const pnlSol = proceedsSol - sizeSol;
      const exitSnapshot = {
        source: "jupiter_expected_fill_quote",
        strategyVersion: STRATEGY_VERSION,
        token_raw_amount: tokenRaw,
        jupiter_quote: quote.raw,
        gross_quoted_out_sol: grossOutSol,
        expected_net_proceeds_sol: proceedsSol,
        gross_return_pct: grossPct,
        net_return_pct: netPct,
        peak_gross_return_pct: peakGrossPct,
        modeled_round_trip_cost_pct: expectedRoundTripCostPct(sizeSol),
        costs: routeFeeSummary(quote.raw),
        simulation_policy: "exit triggers use gross quote movement; realized PnL uses outAmount less expected slippage and flat round-trip costs",
      };

      const { data, error } = await supabase.rpc("close_paper_scalp", {
        p_position_id: position.position_id,
        p_exit_price_usd: grossMark,
        p_gross_return_pct: grossPct,
        p_net_return_pct: netPct,
        p_pnl_sol: pnlSol,
        p_proceeds_sol: proceedsSol,
        p_exit_reason: reason,
        p_closed_at: now,
        p_exit_snapshot: exitSnapshot,
      });
      if (error) throw error;
      if (reason === "hard_stop") await blacklist(position, netPct);

      console.log(
        `[JUPITER EXPECTED CLOSE] ${position.token_symbol} ${reason} ` +
        `gross=${grossPct.toFixed(2)}% net=${netPct.toFixed(2)}% pnl=${pnlSol.toFixed(6)} SOL`
      );
      try {
        await sendTelegramAlert(
          `${pnlSol >= 0 ? "✅" : "🔴"} <b>PAPER SNIPER CLOSED</b>\n\n` +
          `🪙 <b>${position.token_symbol}</b>\n` +
          `Reason: <b>${reason.replaceAll("_", " ")}</b>\n` +
          `Gross move: <b>${grossPct.toFixed(2)}%</b>\n` +
          `Net after modeled costs: <b>${netPct.toFixed(2)}%</b>\n` +
          `Paper PnL: <b>${pnlSol.toFixed(6)} SOL</b>\n\n` +
          `Strategy: <b>${STRATEGY_VERSION}</b>`
        );
      } catch {}
      void data;
    } catch (error) {
      console.error(`[momentum-scalper] executable position check failed ${position.token_symbol}`, error);
    }
  }
}

async function scanSafely(): Promise<void> {
  if (scanRunning) return;
  scanRunning = true;
  try { await runMomentumScalperScan(); } finally { scanRunning = false; }
}

async function checkSafely(): Promise<void> {
  if (positionCheckRunning) return;
  positionCheckRunning = true;
  try { await checkMomentumScalpPositions(); } finally { positionCheckRunning = false; }
}

export function startMomentumScalperScheduler(): void {
  const discoveryEnabled = envEnabled("ENABLE_MOMENTUM_SCALPER", true);
  const managementEnabled = envEnabled("ENABLE_SNIPER_POSITION_MANAGER", true);
  const modeledCostPct = expectedRoundTripCostPct(SCALP_RULES.fixedSizeSol);
  if (!(modeledCostPct < SCALP_RULES.hardStopLossPct)) {
    throw new Error(
      `[momentum-scalper] invalid config: modeled round-trip cost ${modeledCostPct.toFixed(3)}% ` +
      `must be strictly below hard stop ${SCALP_RULES.hardStopLossPct.toFixed(3)}%`
    );
  }

  console.log(
    `[momentum-scalper-config] version=${STRATEGY_VERSION} mode=${SNIPER_MODE} ` +
    `target=${SCALP_RULES.targetProfitPct}% stop=${SCALP_RULES.hardStopLossPct}% ` +
    `trailArm=${SCALP_RULES.trailingActivationGrossPct}% trailGiveback=${SCALP_RULES.trailingGivebackPct}% ` +
    `maxHold=${SCALP_RULES.maxHoldSeconds}s modeledRoundTrip=${modeledCostPct.toFixed(3)}% ` +
    `cooldown=${SCALP_RULES.cooldownMinutes}m dailyCap=${SCALP_RULES.maxDailyEntries} ` +
    `concurrentCap=${SCALP_RULES.maxConcurrentPositions} discovery=${discoveryEnabled} management=${managementEnabled}`
  );

  if (discoveryEnabled) {
    void scanSafely();
    setInterval(() => void scanSafely(), SCAN_INTERVAL_MS);
  }
  if (managementEnabled) {
    void checkSafely();
    setInterval(() => void checkSafely(), POSITION_CHECK_INTERVAL_MS);
  }
}
