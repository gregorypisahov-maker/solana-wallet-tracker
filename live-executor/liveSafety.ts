import { PublicKey } from "@solana/web3.js";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";
import { getLiveConnection } from "../lib/liveWallet";
import { getSupabaseAdmin } from "../lib/supabase";
import { evaluateLiquiditySafety } from "./liquiditySafety";

const LAMPORTS_PER_SOL = 1_000_000_000;
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const MIN_POOL_AGE_MS = Math.max(60_000, Number(process.env.LIVE_MIN_POOL_AGE_MS) || 15 * 60_000);
const MIN_LIQUIDITY_USD = Math.max(25_000, Number(process.env.LIVE_MIN_LIQUIDITY_USD) || 75_000);
const MIN_LIQUIDITY_TO_FDV = Math.min(1, Math.max(0.01, Number(process.env.LIVE_MIN_LIQUIDITY_TO_FDV) || 0.12));
const LIQUIDITY_TO_FDV_ENFORCE = process.env.LIVE_LIQUIDITY_TO_FDV_ENFORCE === "true";
const MIN_H24_VOLUME_USD = Math.max(0, Number(process.env.LIVE_MIN_H24_VOLUME_USD) || 50_000);
const MIN_M5_TRANSACTIONS = Math.max(0, Number(process.env.LIVE_MIN_M5_TRANSACTIONS) || 8);
const MIN_ROUND_TRIP_RECOVERY_PCT = Math.min(99, Math.max(70, Number(process.env.LIVE_MIN_ROUND_TRIP_RECOVERY_PCT) || 95));
const MAX_BUY_PRICE_IMPACT_PCT = Math.min(20, Math.max(0.1, Number(process.env.LIVE_MAX_BUY_PRICE_IMPACT_PCT) || 2));
const MAX_SELL_PRICE_IMPACT_PCT = Math.min(30, Math.max(0.1, Number(process.env.LIVE_MAX_SELL_PRICE_IMPACT_PCT) || 3));
const HOLDER_CONCENTRATION_ENFORCE = process.env.LIVE_HOLDER_CONCENTRATION_ENFORCE !== "false";
const MAX_TOP_HOLDER_PCT = Math.min(100, Math.max(1, Number(process.env.LIVE_MAX_TOP_HOLDER_PCT) || 80));
const MAX_TOP5_HOLDER_PCT = Math.min(100, Math.max(5, Number(process.env.LIVE_MAX_TOP5_HOLDER_PCT) || 95));
const MIN_EXPECTED_TOKEN_OUTPUT_PCT = Math.min(100, Math.max(70, Number(process.env.LIVE_MIN_EXPECTED_TOKEN_OUTPUT_PCT) || 94));
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.LIVE_SAFETY_REQUEST_TIMEOUT_MS) || 10_000);
const LP_SAFETY_ENABLED = process.env.LP_SAFETY_ENABLED !== "false";
const LIVE_LP_SAFETY_ENFORCE = process.env.LIVE_LP_SAFETY_ENFORCE !== "false";
const LP_LOCK_ENFORCE = process.env.LP_LOCK_ENFORCE === "true";
const LP_LOCK_BLOCK_ON_UNKNOWN = process.env.LP_LOCK_BLOCK_ON_UNKNOWN === "true";
const PAPER_HELIUS_MAX_AGE_MS = Math.max(60_000, Number(process.env.AI_PAPER_HELIUS_MAX_AGE_MS) || 15 * 60_000);

console.log(
  `[entry-safety] lp_lock config enforce=${LP_LOCK_ENFORCE} ` +
    `blockOnUnknown=${LP_LOCK_BLOCK_ON_UNKNOWN}`
);

export type LiveEntrySafetyResult = { passed: boolean; reason: string | null; details: Record<string, unknown> };

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`safety_http_${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function reject(reason: string, details: Record<string, unknown>): LiveEntrySafetyResult { return { passed: false, reason, details }; }

/**
 * Helius flow eligibility is intentionally observational in the main AI trader.
 * The isolated helius-flow-paper service owns the hard trade_eligible gate and
 * its separate bankroll. Missing/stale/not-eligible intelligence is recorded
 * here as a would-block verdict, but can never short-circuit the normal safety
 * checks below.
 */
async function observePaperHelius(mint: string, details: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - PAPER_HELIUS_MAX_AGE_MS).toISOString();
  const { data, error } = await supabase
    .from("token_intelligence_snapshots")
    .select("symbol,observed_at,mode,recommendation,snapshot")
    .eq("mint", mint)
    .gte("observed_at", cutoff)
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    Object.assign(details, {
      heliusEligible: null,
      heliusRecommendation: null,
      heliusSignalVersion: null,
      heliusWouldBlock: true,
      heliusShadowOnly: true,
      heliusShadowStatus: "query_failed",
      heliusError: error.message,
      heliusMaxAgeMs: PAPER_HELIUS_MAX_AGE_MS,
    });
    console.warn(`[ai-discovery-trader] helius would_block ${mint} (shadow, not enforced)`);
    return;
  }

  if (!data) {
    Object.assign(details, {
      heliusEligible: null,
      heliusRecommendation: null,
      heliusSignalVersion: null,
      heliusWouldBlock: true,
      heliusShadowOnly: true,
      heliusShadowStatus: "missing_or_stale",
      heliusMaxAgeMs: PAPER_HELIUS_MAX_AGE_MS,
    });
    console.warn(`[ai-discovery-trader] helius would_block ${mint} (shadow, not enforced)`);
    return;
  }

  const snapshot = (data.snapshot ?? {}) as Record<string, any>;
  const tradeEligible = snapshot.trade_eligible === true;
  const symbol = String(data.symbol ?? snapshot.symbol ?? mint);
  Object.assign(details, {
    heliusEligible: tradeEligible,
    heliusRecommendation: data.recommendation ?? snapshot.recommendation ?? null,
    heliusSignalVersion: snapshot.signal_version ?? null,
    heliusWouldBlock: !tradeEligible,
    heliusShadowOnly: true,
    heliusShadowStatus: "fresh",
    heliusObservedAt: data.observed_at,
    heliusMode: data.mode,
    heliusSignalScore: snapshot.signal_score ?? null,
    heliusSignalReasons: snapshot.signal_reasons ?? [],
    heliusMissingEvidence: snapshot.missing_for_trade_eligibility ?? [],
    heliusMaxAgeMs: PAPER_HELIUS_MAX_AGE_MS,
  });

  if (!tradeEligible) {
    console.warn(`[ai-discovery-trader] helius would_block ${symbol} (shadow, not enforced)`);
  }
}

export async function evaluateLiveEntrySafety(input: {
  mint: string;
  sizeSol: number;
  slippageBps: number;
  expectedTokenAmount?: string | null;
  mode?: "live" | "paper";
}): Promise<LiveEntrySafetyResult> {
  const details: Record<string, unknown> = {};
  try {
    const mint = new PublicKey(input.mint);
    const connection = getLiveConnection();
    const parsed = await connection.getParsedAccountInfo(mint, "confirmed");
    const info = (parsed.value?.data as any)?.parsed?.info;
    if (!info) return reject("mint_account_unreadable", details);
    details.mintAuthority = info.mintAuthority ?? null;
    details.freezeAuthority = info.freezeAuthority ?? null;
    details.supply = info.supply ?? null;
    if (info.mintAuthority) return reject("mint_authority_active", details);
    if (info.freezeAuthority) return reject("freeze_authority_active", details);

    const paperCall = input.mode === "paper" || (input.mode == null && input.expectedTokenAmount == null);
    if (paperCall) {
      await observePaperHelius(input.mint, details);
    }

    const supply = BigInt(String(info.supply ?? "0"));
    if (supply <= 0n) return reject("invalid_token_supply", details);
    const largest = await connection.getTokenLargestAccounts(mint, "confirmed");
    const topAmounts = largest.value.slice(0, 5).map((item) => BigInt(item.amount));
    const top1Pct = Number(((topAmounts[0] ?? 0n) * 10_000n) / supply) / 100;
    const top5Pct = Number((topAmounts.reduce((sum, amount) => sum + amount, 0n) * 10_000n) / supply) / 100;
    Object.assign(details, {
      top1HolderPct: top1Pct,
      top5HolderPct: top5Pct,
      holderConcentrationEnforced: HOLDER_CONCENTRATION_ENFORCE,
      holderConcentrationThresholds: { top1Pct: MAX_TOP_HOLDER_PCT, top5Pct: MAX_TOP5_HOLDER_PCT },
      holderConcentrationCaveat: "Raw largest token accounts can include pool vaults and burn accounts; only catastrophic concentration is blocked here.",
    });
    if (HOLDER_CONCENTRATION_ENFORCE && top1Pct > MAX_TOP_HOLDER_PCT) return reject("extreme_top_holder_concentration", details);
    if (HOLDER_CONCENTRATION_ENFORCE && top5Pct > MAX_TOP5_HOLDER_PCT) return reject("extreme_top5_holder_concentration", details);

    const pairs = await fetchJson(`${DEX_URL}/${encodeURIComponent(input.mint)}`);
    const candidates = (Array.isArray(pairs) ? pairs : []).filter((pair: any) => pair?.chainId === "solana" && pair?.baseToken?.address === input.mint);
    const pair = candidates.sort((a: any, b: any) => n(b?.liquidity?.usd) - n(a?.liquidity?.usd))[0];
    if (!pair) return reject("dex_pair_not_found", details);
    const liquidityUsd = n(pair?.liquidity?.usd);
    const fdv = n(pair?.fdv || pair?.marketCap);
    const liquidityToFdv = fdv > 0 ? liquidityUsd / fdv : 0;
    const h24VolumeUsd = n(pair?.volume?.h24);
    const m5Buys = n(pair?.txns?.m5?.buys);
    const m5Sells = n(pair?.txns?.m5?.sells);
    const m5Transactions = m5Buys + m5Sells;
    const pairCreatedAt = n(pair?.pairCreatedAt);
    const poolAgeMs = pairCreatedAt > 0 ? Date.now() - pairCreatedAt : 0;
    const liquidityToFdvPassed = fdv > 0 && liquidityToFdv >= MIN_LIQUIDITY_TO_FDV;
    Object.assign(details, { liquidityUsd, fdv, liquidityToFdv, liquidityToFdvMinimum: MIN_LIQUIDITY_TO_FDV, liquidityToFdvPassed, liquidityToFdvEnforced: LIQUIDITY_TO_FDV_ENFORCE, h24VolumeUsd, m5Buys, m5Sells, m5Transactions, poolAgeMinutes: poolAgeMs / 60_000, pairAddress: pair?.pairAddress ?? null, dexId: pair?.dexId ?? null });
    if (liquidityUsd < MIN_LIQUIDITY_USD) return reject("liquidity_below_live_minimum", details);
    if (LIQUIDITY_TO_FDV_ENFORCE && !liquidityToFdvPassed) return reject("liquidity_to_fdv_too_low", details);
    if (h24VolumeUsd < MIN_H24_VOLUME_USD) return reject("volume_below_live_minimum", details);
    if (m5Transactions < MIN_M5_TRANSACTIONS) return reject("insufficient_recent_transactions", details);
    if (!pairCreatedAt || poolAgeMs < MIN_POOL_AGE_MS) return reject("pool_too_new", details);

    const liveCall = !paperCall;
    if (paperCall || LP_SAFETY_ENABLED) {
      const liquiditySafety = await evaluateLiquiditySafety({ mint: input.mint, pairAddress: pair?.pairAddress ?? null, dexId: pair?.dexId ?? null });
      const enforce = liveCall ? LIVE_LP_SAFETY_ENFORCE : LP_LOCK_ENFORCE;
      const blockOnUnknown = liveCall ? true : LP_LOCK_BLOCK_ON_UNKNOWN;
      const action = !enforce
        ? liquiditySafety.verdict === "LOCKED" ? "pass" : "shadow_would_block"
        : liquiditySafety.verdict === "UNLOCKED" || (liquiditySafety.verdict === "UNKNOWN" && blockOnUnknown)
          ? "block"
          : "pass";
      const lpLock = {
        verdict: liquiditySafety.verdict,
        method: liquiditySafety.method,
        pctLocked: liquiditySafety.pctLocked,
        action,
        poolAddress: liquiditySafety.poolAddress,
        unlockTime: liquiditySafety.unlockTime,
        rawError: liquiditySafety.rawError,
        enforce,
        blockOnUnknown,
      };
      details.lp_lock = lpLock;
      details.liquiditySafety = { ...liquiditySafety, enforced: enforce, blockOnUnknown, action, mode: liveCall ? "live" : "paper" };

      if (paperCall) {
        const symbol = String(pair?.baseToken?.symbol ?? input.mint);
        const pctLocked = liquiditySafety.pctLocked == null ? "unknown" : liquiditySafety.pctLocked.toFixed(2);
        console.log(
          `[ai-discovery-trader] lp_lock ${symbol} verdict=${liquiditySafety.verdict} ` +
            `method=${liquiditySafety.method} pctLocked=${pctLocked} enforce=${enforce} ` +
            `action=${action} pool=${liquiditySafety.poolAddress ?? "unknown"}`
        );
      }

      if (action === "block") {
        return reject(
          liquiditySafety.verdict === "UNLOCKED" ? "liquidity_unlocked" : "liquidity_lock_unknown",
          details
        );
      }
    }

    const inputLamports = BigInt(Math.floor(input.sizeSol * LAMPORTS_PER_SOL));
    const buy = await getJupiterQuote({ inputMint: JUPITER_SOL_MINT, outputMint: input.mint, rawTokenAmount: inputLamports.toString(), slippageBps: input.slippageBps });
    if (!buy.route || buy.outLamports <= 0n) return reject("buy_route_unavailable", details);
    const buyImpact = n(buy.raw?.priceImpactPct) * 100;
    details.buyPriceImpactPct = buyImpact;
    details.quotedTokenAmount = buy.outLamports.toString();
    if (buyImpact > MAX_BUY_PRICE_IMPACT_PCT) return reject("buy_price_impact_too_high", details);
    if (input.expectedTokenAmount && /^\d+$/.test(input.expectedTokenAmount) && BigInt(input.expectedTokenAmount) > 0n) {
      const expected = BigInt(input.expectedTokenAmount);
      const outputPct = Number((buy.outLamports * 10_000n) / expected) / 100;
      details.expectedTokenAmount = expected.toString();
      details.currentOutputVsExpectedPct = outputPct;
      if (outputPct < MIN_EXPECTED_TOKEN_OUTPUT_PCT) return reject("entry_too_extended", details);
    }
    const sell = await getJupiterQuote({ inputMint: input.mint, outputMint: JUPITER_SOL_MINT, rawTokenAmount: buy.outLamports.toString(), slippageBps: input.slippageBps });
    if (!sell.route || sell.outLamports <= 0n) return reject("immediate_sell_route_unavailable", details);
    const recoveryPct = Number((sell.outLamports * 10_000n) / inputLamports) / 100;
    const sellImpact = n(sell.raw?.priceImpactPct) * 100;
    Object.assign(details, { roundTripRecoveryPct: recoveryPct, sellPriceImpactPct: sellImpact, immediateSellLamports: sell.outLamports.toString() });
    if (sellImpact > MAX_SELL_PRICE_IMPACT_PCT) return reject("sell_price_impact_too_high", details);
    if (recoveryPct < MIN_ROUND_TRIP_RECOVERY_PCT) return reject("round_trip_recovery_too_low", details);
    return { passed: true, reason: null, details };
  } catch (error) {
    return reject("live_safety_check_failed", { ...details, error: error instanceof Error ? error.message : String(error) });
  }
}
