const GOPLUS_URL = "https://api.gopluslabs.io/api/v1/solana/token_security";
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.LP_SAFETY_REQUEST_TIMEOUT_MS) || 10_000);
const MIN_LOCKED_PCT = Math.min(100, Math.max(50, Number(process.env.LP_MIN_LOCKED_PCT) || 95));
const MIN_LOCK_DAYS = Math.max(0, Number(process.env.LP_MIN_LOCK_DAYS) || 30);

export type LiquiditySafetyStatus =
  | "locked"
  | "burned"
  | "protocol_controlled"
  | "unlocked"
  | "unknown";

export type LiquiditySafetyResult = {
  passed: boolean;
  status: LiquiditySafetyStatus;
  lockedPct: number | null;
  removablePct: number | null;
  lockExpiry: string | null;
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

export async function evaluateLiquiditySafety(input: {
  mint: string;
  pairAddress?: string | null;
  dexId?: string | null;
}): Promise<LiquiditySafetyResult> {
  const details: Record<string, unknown> = {
    mint: input.mint,
    pairAddress: input.pairAddress ?? null,
    dexId: input.dexId ?? null,
    minimumLockedPct: MIN_LOCKED_PCT,
    minimumLockDays: MIN_LOCK_DAYS,
  };

  try {
    const payload = await fetchJson(`${GOPLUS_URL}?contract_addresses=${encodeURIComponent(input.mint)}`);
    const resultMap = payload?.result ?? {};
    const report = resultMap[input.mint] ?? resultMap[input.mint.toLowerCase()] ?? Object.values(resultMap)[0];
    if (!report || typeof report !== "object") {
      return { passed: false, status: "unknown", lockedPct: null, removablePct: null, lockExpiry: null, owner: null, source: "goplus", reason: "liquidity_report_missing", details: { ...details, responseCode: payload?.code ?? null } };
    }

    const holders = Array.isArray((report as any).holders) ? (report as any).holders : [];
    const lockedHolders = holders.filter((holder: any) => boolish(holder?.is_locked) || /burn|black hole|dead/i.test(String(holder?.tag ?? "")));
    const lockedPctFromHolders = lockedHolders.reduce((sum: number, holder: any) => sum + (pct(holder?.percent) ?? 0), 0);
    const topLevelLockedPct = pct((report as any).locked_percent ?? (report as any).lp_locked_percent ?? (report as any).liquidity_locked_percent);
    const lockedPct = topLevelLockedPct ?? (lockedHolders.length ? Math.min(100, lockedPctFromHolders) : null);
    const isLocked = boolish((report as any).is_locked) || (lockedPct != null && lockedPct > 0);
    const burnDetected = lockedHolders.some((holder: any) => /burn|black hole|dead/i.test(String(holder?.tag ?? "")));
    const lockDetails = [
      ...((Array.isArray((report as any).locked_detail) ? (report as any).locked_detail : [])),
      ...lockedHolders.flatMap((holder: any) => Array.isArray(holder?.locked_detail) ? holder.locked_detail : []),
    ];
    const lockExpiry = expiryFrom(lockDetails);
    const owner = (report as any).owner_address ?? (report as any).creator_address ?? null;
    const removablePct = lockedPct == null ? null : Math.max(0, 100 - lockedPct);
    const expiryMs = lockExpiry ? Date.parse(lockExpiry) : null;
    const minimumExpiryMs = Date.now() + MIN_LOCK_DAYS * 86_400_000;

    Object.assign(details, {
      providerIsLocked: (report as any).is_locked ?? null,
      lockedPct,
      removablePct,
      lockExpiry,
      owner,
      lockedHolderCount: lockedHolders.length,
      lockDetails,
      providerRiskItems: (report as any).risk_items ?? (report as any).risks ?? null,
    });

    if (!isLocked) {
      return { passed: false, status: "unlocked", lockedPct, removablePct, lockExpiry, owner, source: "goplus", reason: "liquidity_not_locked", details };
    }
    if (lockedPct == null) {
      return { passed: false, status: "unknown", lockedPct, removablePct, lockExpiry, owner, source: "goplus", reason: "locked_percentage_unknown", details };
    }
    if (lockedPct < MIN_LOCKED_PCT) {
      return { passed: false, status: "unlocked", lockedPct, removablePct, lockExpiry, owner, source: "goplus", reason: "insufficient_liquidity_locked", details };
    }
    if (expiryMs != null && expiryMs < minimumExpiryMs) {
      return { passed: false, status: "unlocked", lockedPct, removablePct, lockExpiry, owner, source: "goplus", reason: "liquidity_lock_expires_too_soon", details };
    }

    return { passed: true, status: burnDetected ? "burned" : "locked", lockedPct, removablePct, lockExpiry, owner, source: "goplus", reason: null, details };
  } catch (error) {
    return {
      passed: false,
      status: "unknown",
      lockedPct: null,
      removablePct: null,
      lockExpiry: null,
      owner: null,
      source: "unavailable",
      reason: "liquidity_safety_check_failed",
      details: { ...details, error: error instanceof Error ? error.message : String(error) },
    };
  }
}
