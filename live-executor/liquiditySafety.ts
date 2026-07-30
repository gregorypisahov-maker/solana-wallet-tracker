import { getLiveConnection } from "../lib/liveWallet";
import { classifyLpLock, type LpLockResult } from "./lpLockGoplus";
import { evaluateOnchainLiquiditySafety } from "./lpLockOnchain";

const GOPLUS_URL = "https://api.gopluslabs.io/api/v1/solana/token_security";
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.LP_SAFETY_REQUEST_TIMEOUT_MS) || 10_000);
const MIN_LOCKED_PCT = Math.min(100, Math.max(50, Number(process.env.LP_MIN_LOCKED_PCT) || 95));
const MAX_TOP_HOLDER_PCT = Math.min(100, Math.max(5, Number(process.env.LP_MAX_TOP_HOLDER_PCT) || 30));

export type LiquidityLockVerdict = "LOCKED" | "UNLOCKED" | "UNKNOWN";

export type LiquiditySafetyStatus =
  | "locked"
  | "burned"
  | "protocol_controlled"
  | "unlocked"
  | "unknown";

export type LiquiditySafetyResult = {
  verdict: LiquidityLockVerdict;
  method: string;
  pctLocked: number | null;
  pctBurned: number | null;
  poolAddress: string | null;
  lpMint: string | null;
  unlockTime: string | null;
  rawError: string | null;
  status: LiquiditySafetyStatus;
  removablePct: number | null;
  owner: string | null;
  source: "goplus" | "onchain" | "unavailable";
  reason: string | null;
  details: Record<string, unknown>;
};

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (process.env.GOPLUS_API_TOKEN) headers.Authorization = `Bearer ${process.env.GOPLUS_API_TOKEN}`;
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers });
    if (!response.ok) throw new Error(`goplus_http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function goplusResult(classified: LpLockResult, poolAddress: string | null): LiquiditySafetyResult {
  const securedPct = (classified.pctLocked ?? 0) + (classified.pctBurned ?? 0);
  const status: LiquiditySafetyStatus = classified.verdict === "LOCKED"
    ? (classified.pctBurned ?? 0) >= MIN_LOCKED_PCT ? "burned" : "locked"
    : classified.verdict === "UNLOCKED" ? "unlocked" : "unknown";
  return {
    verdict: classified.verdict,
    method: classified.method,
    pctLocked: classified.pctLocked,
    pctBurned: classified.pctBurned,
    poolAddress: classified.pool ?? poolAddress,
    lpMint: null,
    unlockTime: classified.unlockTime,
    rawError: null,
    status,
    removablePct: classified.verdict === "UNKNOWN" ? null : Math.max(0, 100 - securedPct),
    owner: null,
    source: "goplus",
    reason: classified.verdict === "UNLOCKED"
      ? "insufficient_liquidity_locked"
      : classified.verdict === "UNKNOWN" ? "liquidity_lock_unknown" : null,
    details: classified.details,
  };
}

export async function evaluateLiquiditySafety(input: {
  mint: string;
  pairAddress?: string | null;
  dexId?: string | null;
}): Promise<LiquiditySafetyResult> {
  const poolAddress = input.pairAddress ?? null;
  const common = {
    mint: input.mint,
    pairAddress: poolAddress,
    dexId: input.dexId ?? null,
    minimumLockedPct: MIN_LOCKED_PCT,
    maxTopHolderPct: MAX_TOP_HOLDER_PCT,
  };

  let goPlus: LpLockResult;
  try {
    const payload = await fetchJson(`${GOPLUS_URL}?contract_addresses=${encodeURIComponent(input.mint)}`);
    goPlus = classifyLpLock(payload, input.mint, {
      lockMinPct: MIN_LOCKED_PCT / 100,
      poolAddress,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    goPlus = {
      verdict: "UNKNOWN",
      method: "goplus_request_failed",
      pctLocked: null,
      pctBurned: null,
      pool: poolAddress,
      unlockTime: null,
      details: { error: message },
    };
  }

  if (goPlus.verdict !== "UNKNOWN") {
    const resolved = goplusResult(goPlus, poolAddress);
    resolved.details = { ...common, goplus: goPlus, resolution: "goplus" };
    return resolved;
  }

  try {
    const onchain = await evaluateOnchainLiquiditySafety({
      connection: getLiveConnection(),
      mint: input.mint,
      poolAddress,
      lockMinPct: MIN_LOCKED_PCT,
      maxTopHolderPct: MAX_TOP_HOLDER_PCT,
    });
    return {
      verdict: onchain.verdict,
      method: onchain.method,
      pctLocked: onchain.pctLocked,
      pctBurned: onchain.pctBurned,
      poolAddress: onchain.poolAddress,
      lpMint: onchain.lpMint,
      unlockTime: null,
      rawError: null,
      status: onchain.status,
      removablePct: onchain.removablePct,
      owner: onchain.owner,
      source: "onchain",
      reason: onchain.reason,
      details: {
        ...common,
        goplus: goPlus,
        onchain: onchain.details,
        resolution: "onchain_fallback",
      },
    };
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    return {
      verdict: "UNKNOWN",
      method: "onchain_authorities",
      pctLocked: null,
      pctBurned: null,
      poolAddress,
      lpMint: null,
      unlockTime: null,
      rawError,
      status: "unknown",
      removablePct: null,
      owner: null,
      source: "unavailable",
      reason: "liquidity_safety_check_failed",
      details: {
        ...common,
        goplus: goPlus,
        onchainError: rawError,
        resolution: "unresolved",
      },
    };
  }
}
