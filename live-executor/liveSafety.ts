import { PublicKey } from "@solana/web3.js";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";
import { getLiveConnection } from "../lib/liveWallet";
import { evaluateLiquiditySafety } from "./liquiditySafety";

const LAMPORTS_PER_SOL = 1_000_000_000;
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const MIN_POOL_AGE_MS = Math.max(60_000, Number(process.env.LIVE_MIN_POOL_AGE_MS) || 15 * 60_000);
const MIN_LIQUIDITY_USD = Math.max(25_000, Number(process.env.LIVE_MIN_LIQUIDITY_USD) || 75_000);
const MIN_LIQUIDITY_TO_FDV = Math.min(1, Math.max(0.01, Number(process.env.LIVE_MIN_LIQUIDITY_TO_FDV) || 0.12));
const MIN_H24_VOLUME_USD = Math.max(0, Number(process.env.LIVE_MIN_H24_VOLUME_USD) || 50_000);
const MIN_M5_TRANSACTIONS = Math.max(0, Number(process.env.LIVE_MIN_M5_TRANSACTIONS) || 8);
const MIN_ROUND_TRIP_RECOVERY_PCT = Math.min(99, Math.max(70, Number(process.env.LIVE_MIN_ROUND_TRIP_RECOVERY_PCT) || 95));
const MAX_BUY_PRICE_IMPACT_PCT = Math.min(20, Math.max(0.1, Number(process.env.LIVE_MAX_BUY_PRICE_IMPACT_PCT) || 2));
const MAX_SELL_PRICE_IMPACT_PCT = Math.min(30, Math.max(0.1, Number(process.env.LIVE_MAX_SELL_PRICE_IMPACT_PCT) || 3));
const HOLDER_CONCENTRATION_ENFORCE = process.env.LIVE_HOLDER_CONCENTRATION_ENFORCE === "true";
const MAX_TOP_HOLDER_PCT = Math.min(100, Math.max(1, Number(process.env.LIVE_MAX_TOP_HOLDER_PCT) || 12));
const MAX_TOP5_HOLDER_PCT = Math.min(100, Math.max(5, Number(process.env.LIVE_MAX_TOP5_HOLDER_PCT) || 35));
const MIN_EXPECTED_TOKEN_OUTPUT_PCT = Math.min(100, Math.max(70, Number(process.env.LIVE_MIN_EXPECTED_TOKEN_OUTPUT_PCT) || 94));
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.LIVE_SAFETY_REQUEST_TIMEOUT_MS) || 10_000);
const LP_SAFETY_ENABLED = process.env.LP_SAFETY_ENABLED !== "false";
const LIVE_LP_SAFETY_ENFORCE = process.env.LIVE_LP_SAFETY_ENFORCE !== "false";
const PAPER_LP_SAFETY_ENFORCE = process.env.AI_PAPER_LP_SAFETY_ENFORCE === "true";

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

    const supply = BigInt(String(info.supply ?? "0"));
    if (supply <= 0n) return reject("invalid_token_supply", details);
    const largest = await connection.getTokenLargestAccounts(mint, "confirmed");
    const topAmounts = largest.value.slice(0, 5).map((item) => BigInt(item.amount));
    const top1Pct = Number(((topAmounts[0] ?? 0n) * 10_000n) / supply) / 100;
    const top5Pct = Number((topAmounts.reduce((sum, amount) => sum + amount, 0n) * 10_000n) / supply) / 100;
    Object.assign(details, { top1HolderPct: top1Pct, top5HolderPct: top5Pct, holderConcentrationEnforced: HOLDER_CONCENTRATION_ENFORCE, holderConcentrationCaveat: "raw largest token accounts include pool vaults and burn accounts until classified" });
    if (HOLDER_CONCENTRATION_ENFORCE && top1Pct > MAX_TOP_HOLDER_PCT) return reject("top_holder_concentration", details);
    if (HOLDER_CONCENTRATION_ENFORCE && top5Pct > MAX_TOP5_HOLDER_PCT) return reject("top5_holder_concentration", details);

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
    Object.assign(details, { liquidityUsd, fdv, liquidityToFdv, h24VolumeUsd, m5Buys, m5Sells, poolAgeMinutes: poolAgeMs / 60_000, pairAddress: pair?.pairAddress ?? null, dexId: pair?.dexId ?? null });
    if (liquidityUsd < MIN_LIQUIDITY_USD) return reject("liquidity_below_live_minimum", details);
    if (fdv <= 0 || liquidityToFdv < MIN_LIQUIDITY_TO_FDV) return reject("liquidity_to_fdv_too_low", details);
    if (h24VolumeUsd < MIN_H24_VOLUME_USD) return reject("volume_below_live_minimum", details);
    if (m5Transactions < MIN_M5_TRANSACTIONS) return reject("insufficient_recent_transactions", details);
    if (!pairCreatedAt || poolAgeMs < MIN_POOL_AGE_MS) return reject("pool_too_new", details);

    if (LP_SAFETY_ENABLED) {
      const liquiditySafety = await evaluateLiquiditySafety({ mint: input.mint, pairAddress: pair?.pairAddress ?? null, dexId: pair?.dexId ?? null });
      const liveCall = input.mode === "live" || (input.mode == null && input.expectedTokenAmount != null);
      const enforce = liveCall ? LIVE_LP_SAFETY_ENFORCE : PAPER_LP_SAFETY_ENFORCE;
      details.liquiditySafety = { ...liquiditySafety, enforced: enforce, mode: liveCall ? "live" : "paper" };
      if (!liquiditySafety.passed && enforce) return reject(liquiditySafety.reason || "liquidity_safety_rejected", details);
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
