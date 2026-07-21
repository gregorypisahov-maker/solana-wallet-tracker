import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import { decideScalpExit, SCALP_RULES } from "./momentumScalperRules";
import { runMomentumScalperScan as runBaseMomentumScalperScan } from "./momentumScalperBase";

const supabase = getSupabaseAdmin();
const DEX_TOKEN_URL = "https://api.dexscreener.com/tokens/v1/solana";
const REQUEST_TIMEOUT_MS = 12_000;
export const STRATEGY_VERSION = "momentum_hardstop_blacklist_v6_2026_07_21";
const SUSPECT_DROP_PCT = 90;
const SUSPECT_CONFIRM_MS = 10_000;
const suspectPrices = new Map<string, { price: number; seenAt: number }>();
let scanRunning = false;
let positionCheckRunning = false;

type ScalpPositionRow = {
  position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  entry_price_usd: number | string;
  entry_time: string;
  size_sol: number | string;
  peak_price_usd: number | string;
};

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedInterval(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const SCAN_INTERVAL_MS = boundedInterval(process.env.SCALP_SCAN_INTERVAL_MS, 60_000, 30_000, 5 * 60_000);
const POSITION_CHECK_INTERVAL_MS = boundedInterval(process.env.SCALP_POSITION_CHECK_MS, 3_000, 3_000, 60_000);

function envEnabled(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBoundDexSnapshot(mint: string, pairAddress: string) {
  const body = await fetchJson(`${DEX_TOKEN_URL}/${encodeURIComponent(mint)}`);
  const pairs = Array.isArray(body) ? body : [];
  const pair = pairs.find((item: any) =>
    item?.chainId === "solana" &&
    item?.baseToken?.address === mint &&
    String(item?.pairAddress ?? "") === pairAddress
  );
  if (!pair) throw new Error(`DexScreener selected pair missing for ${mint}`);
  return {
    pairAddress,
    priceUsd: numberValue(pair?.priceUsd, NaN),
    liquidityUsd: numberValue(pair?.liquidity?.usd, NaN),
    marketCapUsd: numberValue(pair?.marketCap ?? pair?.fdv, NaN),
    fiveMinuteChangePct: numberValue(pair?.priceChange?.m5, NaN),
  };
}

async function loadPositions(): Promise<ScalpPositionRow[]> {
  const { data, error } = await supabase.from("scalp_positions").select("*").order("entry_time", { ascending: true });
  if (error) throw new Error(`scalp position load failed: ${error.message}`);
  return (data ?? []) as ScalpPositionRow[];
}

function isConfirmedExitPrice(positionId: string, entryPriceUsd: number, priceUsd: number): boolean {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
    return false;
  }
  const dropPct = (1 - priceUsd / entryPriceUsd) * 100;
  if (dropPct <= SUSPECT_DROP_PCT) {
    suspectPrices.delete(positionId);
    return true;
  }
  const prior = suspectPrices.get(positionId);
  const now = Date.now();
  if (!prior) {
    suspectPrices.set(positionId, { price: priceUsd, seenAt: now });
    return false;
  }
  if (now - prior.seenAt < SUSPECT_CONFIRM_MS) return false;
  suspectPrices.delete(positionId);
  return true;
}

async function writeHardStopBlacklist(position: ScalpPositionRow, closedAt: string, netReturnPct: number): Promise<void> {
  const cutoff = new Date(Date.parse(closedAt) - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from("scalp_trades")
    .select("id", { count: "exact", head: true })
    .eq("mint", position.mint)
    .eq("exit_reason", "hard_stop")
    .gte("closed_at", cutoff);
  if (countError) throw new Error(`hard-stop history lookup failed: ${countError.message}`);
  const banHours = (count ?? 0) >= 1 ? 24 : 4;
  const { error } = await supabase.from("scalp_blacklist").upsert({
    mint: position.mint,
    blacklisted_until: new Date(Date.parse(closedAt) + banHours * 60 * 60 * 1000).toISOString(),
    reason: `hard_stop_${banHours}h:${netReturnPct.toFixed(2)}pct`,
  }, { onConflict: "mint" });
  if (error) throw new Error(`hard-stop blacklist write failed: ${error.message}`);
}

export async function runMomentumScalperScan(): Promise<void> {
  await runBaseMomentumScalperScan();
}

export async function checkMomentumScalpPositions(): Promise<void> {
  const positions = await loadPositions();
  for (const position of positions) {
    try {
      const market = await fetchBoundDexSnapshot(position.mint, position.pair_address);
      const entryPriceUsd = numberValue(position.entry_price_usd, NaN);
      if (!isConfirmedExitPrice(position.position_id, entryPriceUsd, market.priceUsd)) {
        console.warn(`[momentum-scalper] price_fetch_suspect ${position.token_symbol} entry=${entryPriceUsd} fetched=${market.priceUsd}`);
        continue;
      }

      const peakPriceUsd = Math.max(numberValue(position.peak_price_usd, entryPriceUsd), market.priceUsd);
      const nowMs = Date.now();
      const decision = decideScalpExit({
        entryPriceUsd,
        currentPriceUsd: market.priceUsd,
        peakPriceUsd,
        openedAtMs: Date.parse(position.entry_time),
        nowMs,
      });
      const now = new Date(nowMs).toISOString();

      if (!decision) {
        const { error } = await supabase.from("scalp_positions").update({
          peak_price_usd: peakPriceUsd,
          last_price_usd: market.priceUsd,
          last_checked_at: now,
          updated_at: now,
        }).eq("position_id", position.position_id);
        if (error) throw new Error(`scalp mark update failed: ${error.message}`);
        continue;
      }

      const sizeSol = numberValue(position.size_sol);
      const proceedsSol = sizeSol * decision.netMultiple;
      const pnlSol = proceedsSol - sizeSol;
      const exitSnapshot = {
        source: "dexscreener",
        strategyVersion: STRATEGY_VERSION,
        market,
        peakPriceUsd,
        priceMultiple: market.priceUsd / entryPriceUsd,
        netMultiple: decision.netMultiple,
        priceSanity: { suspectDropPct: SUSPECT_DROP_PCT, confirmed: true },
        friction: { entryPct: SCALP_RULES.entryFrictionPct, exitPct: SCALP_RULES.exitFrictionPct },
      };

      const { data, error } = await supabase.rpc("close_paper_scalp", {
        p_position_id: position.position_id,
        p_exit_price_usd: market.priceUsd,
        p_gross_return_pct: decision.grossReturnPct,
        p_net_return_pct: decision.netReturnPct,
        p_pnl_sol: pnlSol,
        p_proceeds_sol: proceedsSol,
        p_exit_reason: decision.reason,
        p_closed_at: now,
        p_exit_snapshot: exitSnapshot,
      });
      if (error) throw new Error(`paper scalp close failed: ${error.message}`);

      if (decision.reason === "hard_stop") {
        await writeHardStopBlacklist(position, now, decision.netReturnPct);
      }

      const result = (data ?? {}) as Record<string, unknown>;
      console.log(`[MOMENTUM SCALP CLOSE] ${position.token_symbol} | ${decision.reason} | net ${decision.netReturnPct.toFixed(2)}% | PnL ${pnlSol.toFixed(5)} SOL`);
      try {
        await sendTelegramAlert([
          `${pnlSol >= 0 ? "✅" : "🔴"} <b>PAPER MOMENTUM SCALP CLOSED</b>`,
          "",
          `🪙 <b>${position.token_symbol}</b>`,
          `Reason: <b>${decision.reason.replaceAll("_", " ")}</b>`,
          `Net after friction: <b>${decision.netReturnPct.toFixed(2)}%</b>`,
          `Paper PnL: <b>${pnlSol.toFixed(5)} SOL</b>`,
          decision.reason === "hard_stop" ? "🚫 Token added to the temporary scalper blacklist." : "",
          result.halted ? `🛑 Risk guard: <b>${String(result.haltReason ?? "halted")}</b>` : "",
          "",
          `Strategy: <b>${STRATEGY_VERSION}</b>`,
        ].filter(Boolean).join("\n"));
      } catch (alertError) {
        console.warn("[momentum-scalper] close alert failed after position closed:", alertError);
      }
    } catch (error) {
      console.error(`[momentum-scalper] ${position.token_symbol} position check failed:`, error);
    }
  }
}

async function scanSafely(): Promise<void> {
  if (scanRunning) return;
  scanRunning = true;
  try { await runMomentumScalperScan(); } finally { scanRunning = false; }
}

async function checkPositionsSafely(): Promise<void> {
  if (positionCheckRunning) return;
  positionCheckRunning = true;
  try { await checkMomentumScalpPositions(); } finally { positionCheckRunning = false; }
}

export function startMomentumScalperScheduler(): void {
  if (!envEnabled("ENABLE_MOMENTUM_SCALPER", true)) {
    console.log("[momentum-scalper] disabled by ENABLE_MOMENTUM_SCALPER");
    return;
  }
  console.log(`[momentum-scalper] ${STRATEGY_VERSION} paper-only strategy enabled; scan ${SCAN_INTERVAL_MS / 1000}s; position check ${POSITION_CHECK_INTERVAL_MS / 1000}s; size ${SCALP_RULES.fixedSizeSol.toFixed(2)} SOL`);
  void scanSafely().catch((error) => console.error("[momentum-scalper] initial scan failed:", error));
  void checkPositionsSafely().catch((error) => console.error("[momentum-scalper] initial position check failed:", error));
  setInterval(() => void scanSafely().catch((error) => console.error("[momentum-scalper] scheduled scan failed:", error)), SCAN_INTERVAL_MS);
  setInterval(() => void checkPositionsSafely().catch((error) => console.error("[momentum-scalper] scheduled position check failed:", error)), POSITION_CHECK_INTERVAL_MS);
}
