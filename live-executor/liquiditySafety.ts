const GOPLUS_URL = "https://api.gopluslabs.io/api/v1/solana/token_security";
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.LP_SAFETY_REQUEST_TIMEOUT_MS) || 10_000);
const MIN_LOCKED_PCT = Math.min(100, Math.max(50, Number(process.env.LP_MIN_LOCKED_PCT) || 95));

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
  poolAddress: string | null;
  unlockTime: string | null;
  rawError: string | null;
  status: LiquiditySafetyStatus;
  removablePct: number | null;
  owner: string | null;
  source: "goplus" | "unavailable";
  reason: string | null;
  details: Record<string, unknown>;
};

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolish(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function falseish(value: unknown): boolean {
  return value === false || value === 0 || value === "0" || value === "false";
}

function pct(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = n(value, Number.NaN);
  if (!Number.isFinite(parsed)) return null;
  return parsed <= 1 ? parsed * 100 : parsed;
}

function expiryFrom(details: any[]): string | null {
  const timestamps = details
    .flatMap((item) => [item?.end_time, item?.unlock_time, item?.expiry_time])
    .map((value) => n(value))
    .filter((value) => value > 0);
  if (!timestamps.length) return null;
  const latest = Math.max(...timestamps);
  return new Date(latest > 10_000_000_000 ? latest : latest * 1_000).toISOString();
}

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

function result(input: {
  verdict: LiquidityLockVerdict;
  method: string;
  pctLocked: number | null;
  poolAddress: string | null;
  unlockTime: string | null;
  rawError?: string | null;
  status: LiquiditySafetyStatus;
  removablePct: number | null;
  owner: string | null;
  source: "goplus" | "unavailable";
  reason?: string | null;
  details: Record<string, unknown>;
}): LiquiditySafetyResult {
  return {
    verdict: input.verdict,
    method: input.method,
    pctLocked: input.pctLocked,
    poolAddress: input.poolAddress,
    unlockTime: input.unlockTime,
    rawError: input.rawError ?? null,
    status: input.status,
    removablePct: input.removablePct,
    owner: input.owner,
    source: input.source,
    reason: input.reason ?? null,
    details: input.details,
  };
}

export async function evaluateLiquiditySafety(input: {
  mint: string;
  pairAddress?: string | null;
  dexId?: string | null;
}): Promise<LiquiditySafetyResult> {
  const poolAddress = input.pairAddress ?? null;
  const details: Record<string, unknown> = {
    mint: input.mint,
    pairAddress: poolAddress,
    dexId: input.dexId ?? null,
    minimumLockedPct: MIN_LOCKED_PCT,
  };

  try {
    const payload = await fetchJson(`${GOPLUS_URL}?contract_addresses=${encodeURIComponent(input.mint)}`);
    const resultMap = payload?.result ?? {};
    const report = resultMap[input.mint] ?? resultMap[input.mint.toLowerCase()] ?? Object.values(resultMap)[0];
    if (!report || typeof report !== "object") {
      return result({
        verdict: "UNKNOWN",
        method: "goplus_report_missing",
        pctLocked: null,
        poolAddress,
        unlockTime: null,
        status: "unknown",
        removablePct: null,
        owner: null,
        source: "goplus",
        reason: "liquidity_report_missing",
        details: { ...details, responseCode: payload?.code ?? null },
      });
    }

    const holders = Array.isArray((report as any).holders) ? (report as any).holders : [];
    const lockedHolders = holders.filter((holder: any) => boolish(holder?.is_locked) || /burn|black hole|dead/i.test(String(holder?.tag ?? "")));
    const lockedPctFromHolders = lockedHolders.reduce((sum: number, holder: any) => sum + (pct(holder?.percent) ?? 0), 0);
    const topLevelLockedPct = pct((report as any).locked_percent ?? (report as any).lp_locked_percent ?? (report as any).liquidity_locked_percent);
    const pctLocked = topLevelLockedPct ?? (lockedHolders.length ? Math.min(100, lockedPctFromHolders) : null);
    const providerHasLockFlag = Object.prototype.hasOwnProperty.call(report, "is_locked");
    const providerSaysLocked = providerHasLockFlag && boolish((report as any).is_locked);
    const providerSaysUnlocked = providerHasLockFlag && falseish((report as any).is_locked);
    const burnDetected = lockedHolders.some((holder: any) => /burn|black hole|dead/i.test(String(holder?.tag ?? "")));
    const lockDetails = [
      ...((Array.isArray((report as any).locked_detail) ? (report as any).locked_detail : [])),
      ...lockedHolders.flatMap((holder: any) => Array.isArray(holder?.locked_detail) ? holder.locked_detail : []),
    ];
    const unlockTime = expiryFrom(lockDetails);
    const owner = (report as any).owner_address ?? (report as any).creator_address ?? null;
    const removablePct = pctLocked == null ? null : Math.max(0, 100 - pctLocked);
    const expiryMs = unlockTime ? Date.parse(unlockTime) : null;

    Object.assign(details, {
      providerIsLocked: (report as any).is_locked ?? null,
      providerHasLockFlag,
      pctLocked,
      removablePct,
      unlockTime,
      owner,
      lockedHolderCount: lockedHolders.length,
      lockDetails,
      providerRiskItems: (report as any).risk_items ?? (report as any).risks ?? null,
    });

    if (burnDetected) {
      if (pctLocked == null) {
        return result({
          verdict: "UNKNOWN",
          method: "goplus_burn_pct_unknown",
          pctLocked,
          poolAddress,
          unlockTime,
          status: "unknown",
          removablePct,
          owner,
          source: "goplus",
          reason: "burn_percentage_unknown",
          details,
        });
      }
      if (pctLocked < MIN_LOCKED_PCT) {
        return result({
          verdict: "UNLOCKED",
          method: "goplus_partial_burn",
          pctLocked,
          poolAddress,
          unlockTime,
          status: "unlocked",
          removablePct,
          owner,
          source: "goplus",
          reason: "insufficient_liquidity_locked",
          details,
        });
      }
      return result({
        verdict: "LOCKED",
        method: "goplus_burn_address",
        pctLocked,
        poolAddress,
        unlockTime,
        status: "burned",
        removablePct,
        owner,
        source: "goplus",
        details,
      });
    }

    if (expiryMs != null && expiryMs <= Date.now()) {
      return result({
        verdict: "UNLOCKED",
        method: "goplus_lock_expired",
        pctLocked,
        poolAddress,
        unlockTime,
        status: "unlocked",
        removablePct,
        owner,
        source: "goplus",
        reason: "liquidity_lock_expired",
        details,
      });
    }

    if (pctLocked != null && pctLocked < MIN_LOCKED_PCT) {
      return result({
        verdict: "UNLOCKED",
        method: "goplus_insufficient_locked_pct",
        pctLocked,
        poolAddress,
        unlockTime,
        status: "unlocked",
        removablePct,
        owner,
        source: "goplus",
        reason: "insufficient_liquidity_locked",
        details,
      });
    }

    if ((providerSaysLocked || lockedHolders.length > 0) && pctLocked != null && expiryMs != null && expiryMs > Date.now()) {
      return result({
        verdict: "LOCKED",
        method: "goplus_locker_future_unlock",
        pctLocked,
        poolAddress,
        unlockTime,
        status: "locked",
        removablePct,
        owner,
        source: "goplus",
        details,
      });
    }

    if (providerSaysUnlocked || pctLocked === 0) {
      return result({
        verdict: "UNLOCKED",
        method: "goplus_explicit_unlocked",
        pctLocked,
        poolAddress,
        unlockTime,
        status: "unlocked",
        removablePct,
        owner,
        source: "goplus",
        reason: "provider_reports_unlocked",
        details,
      });
    }

    return result({
      verdict: "UNKNOWN",
      method: providerSaysLocked || lockedHolders.length > 0 ? "goplus_lock_metadata_incomplete" : "goplus_lock_state_unrecognized",
      pctLocked,
      poolAddress,
      unlockTime,
      status: "unknown",
      removablePct,
      owner,
      source: "goplus",
      reason: "liquidity_lock_unknown",
      details,
    });
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    return result({
      verdict: "UNKNOWN",
      method: "goplus_request_failed",
      pctLocked: null,
      poolAddress,
      unlockTime: null,
      rawError,
      status: "unknown",
      removablePct: null,
      owner: null,
      source: "unavailable",
      reason: "liquidity_safety_check_failed",
      details: { ...details, error: rawError },
    });
  }
}
