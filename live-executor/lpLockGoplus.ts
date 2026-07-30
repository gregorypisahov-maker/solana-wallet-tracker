// Correct GoPlus Solana LP-lock classifier.
// Solana lock data is nested per pool at result[mint].dex[].lp_holders[].

export type LpLockVerdict = "LOCKED" | "UNLOCKED" | "UNKNOWN";

export interface LpLockResult {
  verdict: LpLockVerdict;
  method: string;
  pctLocked: number | null;
  pctBurned: number | null;
  pool: string | null;
  unlockTime: string | null;
  details: Record<string, unknown>;
}

export const LP_BURN_ADDRESSES = new Set<string>([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);

function num(value: unknown): number {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLocked(value: unknown): boolean {
  return value === 1 || value === "1" || value === true || value === "true";
}

function fractionOf(holder: any): number {
  const raw = num(holder?.percent);
  if (raw <= 0) return 0;
  return raw > 1 ? raw / 100 : raw;
}

function lockExpiry(holders: any[]): string | null {
  const times = holders
    .flatMap((holder) => Array.isArray(holder?.locked_detail) ? holder.locked_detail : [])
    .flatMap((item) => [item?.end_time, item?.unlock_time, item?.expiry_time])
    .map(num)
    .filter((value) => value > 0);
  if (!times.length) return null;
  const latest = Math.max(...times);
  return new Date(latest > 10_000_000_000 ? latest : latest * 1_000).toISOString();
}

function burnHolder(holder: any): boolean {
  const candidates = [holder?.token_account, holder?.address, holder?.owner_address]
    .filter(Boolean)
    .map(String);
  return candidates.some((address) => LP_BURN_ADDRESSES.has(address)) ||
    /burn|black hole|dead|incinerator/i.test(String(holder?.tag ?? ""));
}

export function classifyLpLock(
  response: any,
  mint: string,
  options: { lockMinPct?: number; poolAddress?: string | null } = {}
): LpLockResult {
  const lockMin = options.lockMinPct ?? 0.9;
  const make = (
    verdict: LpLockVerdict,
    method: string,
    extra: Partial<LpLockResult> = {}
  ): LpLockResult => ({
    verdict,
    method,
    pctLocked: null,
    pctBurned: null,
    pool: null,
    unlockTime: null,
    details: {},
    ...extra,
  });

  if (!response || typeof response !== "object") {
    return make("UNKNOWN", "goplus_no_response");
  }
  if (Number(response.code) === 2007) {
    return make("UNKNOWN", "goplus_token_not_indexed", {
      details: { responseCode: response.code, message: response.message ?? null },
    });
  }
  if (Number(response.code) !== 1 || !response.result || typeof response.result !== "object") {
    return make("UNKNOWN", "goplus_error_code", {
      details: { responseCode: response.code ?? null, message: response.message ?? null },
    });
  }

  let tokenData = response.result[mint] ?? response.result[String(mint).toLowerCase()];
  if (!tokenData) {
    const keys = Object.keys(response.result);
    if (keys.length === 1) tokenData = response.result[keys[0]];
  }
  if (!tokenData || typeof tokenData !== "object") {
    return make("UNKNOWN", "goplus_mint_absent");
  }

  const dexes: any[] = Array.isArray(tokenData.dex) ? tokenData.dex : [];
  if (dexes.length === 0) {
    return make("UNKNOWN", "goplus_no_dex");
  }

  const withHolders = dexes.filter(
    (dex) => Array.isArray(dex?.lp_holders) && dex.lp_holders.length > 0
  );
  const requestedPool = options.poolAddress
    ? withHolders.find((dex) => String(dex?.id ?? dex?.address ?? "") === options.poolAddress)
    : null;
  const pool = requestedPool ?? [...withHolders].sort((a, b) => num(b?.tvl) - num(a?.tvl))[0];

  if (!pool) {
    return make("UNKNOWN", "goplus_no_lp_holders", {
      pool: options.poolAddress ?? String(dexes[0]?.id ?? dexes[0]?.address ?? "") || null,
      details: { dexCount: dexes.length },
    });
  }

  let lockedFraction = 0;
  let burnedFraction = 0;
  const holders = pool.lp_holders as any[];
  for (const holder of holders) {
    if (burnHolder(holder)) {
      burnedFraction += fractionOf(holder);
      continue;
    }
    if (isLocked(holder?.is_locked)) lockedFraction += fractionOf(holder);
  }

  const pctLocked = Number((Math.min(1, lockedFraction) * 100).toFixed(2));
  const pctBurned = Number((Math.min(1, burnedFraction) * 100).toFixed(2));
  const securedFraction = lockedFraction + burnedFraction;
  const poolId = String(pool?.id ?? pool?.address ?? options.poolAddress ?? "") || null;
  const unlockTime = lockExpiry(holders);
  const details = {
    holderCount: holders.length,
    securedPct: Number((Math.min(1, securedFraction) * 100).toFixed(2)),
    requestedPool: options.poolAddress ?? null,
    selectedPool: poolId,
  };

  return securedFraction >= lockMin
    ? make("LOCKED", "goplus_lp_holders", { pctLocked, pctBurned, pool: poolId, unlockTime, details })
    : make("UNLOCKED", "goplus_lp_holders", { pctLocked, pctBurned, pool: poolId, unlockTime, details });
}
