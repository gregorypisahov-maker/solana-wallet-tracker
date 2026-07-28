import { FetchPriority, fetchJsonQueued } from "../paper-trader/fetchQueue";

export type TokenSafetyCheck = "S2_mint_authority" | "S3_freeze_authority" | "S4_top10_concentration";

export type TokenSafetyResult = {
  passed: boolean;
  checkFailed: TokenSafetyCheck | "rpc_unknown" | null;
  observedValue: unknown;
  snapshot: Record<string, unknown>;
};

type RpcResponse<T> = { jsonrpc?: string; id?: number; result?: T; error?: { code?: number; message?: string } };

const cache = new Map<string, Promise<TokenSafetyResult>>();
const RPC_TIMEOUT_MS = Math.max(500, Math.min(10_000, Number(process.env.AI_TOKEN_SAFETY_RPC_TIMEOUT_MS) || 2_000));
const TOP10_LIMIT_PCT = Math.max(1, Math.min(100, Number(process.env.AI_TOKEN_SAFETY_TOP10_MAX_PCT) || 25));
const S2_ENABLED = process.env.AI_TOKEN_SAFETY_S2_ENABLED !== "false";
const S3_ENABLED = process.env.AI_TOKEN_SAFETY_S3_ENABLED !== "false";
const S4_ENABLED = process.env.AI_TOKEN_SAFETY_S4_ENABLED === "true";

function rpcUrl(): string {
  const url = process.env.ALCHEMY_RPC_URL?.trim() || process.env.SOLANA_RPC_URL?.trim();
  if (!url) throw new Error("token_safety_rpc_url_missing");
  return url;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const response = (await fetchJsonQueued(rpcUrl(), {
    method: "POST",
    body,
    priority: FetchPriority.HIGH,
    timeoutMs: RPC_TIMEOUT_MS,
    cacheTtlMs: 0,
    headers: { "content-type": "application/json" },
  })) as RpcResponse<T>;
  if (response.error || response.result == null) {
    throw new Error(`token_safety_rpc_${method}_${response.error?.code ?? "unknown"}:${response.error?.message ?? "missing_result"}`);
  }
  return response.result;
}

function fail(checkFailed: TokenSafetyResult["checkFailed"], observedValue: unknown, snapshot: Record<string, unknown>): TokenSafetyResult {
  return { passed: false, checkFailed, observedValue, snapshot };
}

async function evaluate(mint: string): Promise<TokenSafetyResult> {
  const snapshot: Record<string, unknown> = {
    version: "token_safety_s2_s4_v1_2026_07_28",
    mint,
    flags: { S2_ENABLED, S3_ENABLED, S4_ENABLED },
    thresholds: { top10MaxPct: TOP10_LIMIT_PCT },
  };

  try {
    const account = await rpc<any>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const info = account?.value?.data?.parsed?.info;
    if (!info) return fail("rpc_unknown", "mint_account_unreadable", snapshot);

    const mintAuthority = info.mintAuthority ?? null;
    const freezeAuthority = info.freezeAuthority ?? null;
    const supplyRaw = String(info.supply ?? "0");
    snapshot.mintAuthority = mintAuthority;
    snapshot.freezeAuthority = freezeAuthority;
    snapshot.supplyRaw = supplyRaw;

    if (S2_ENABLED && mintAuthority !== null) return fail("S2_mint_authority", mintAuthority, snapshot);
    if (S3_ENABLED && freezeAuthority !== null) return fail("S3_freeze_authority", freezeAuthority, snapshot);

    if (S4_ENABLED) {
      const supply = BigInt(supplyRaw);
      if (supply <= 0n) return fail("rpc_unknown", "invalid_supply", snapshot);
      const largest = await rpc<any>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
      const values = Array.isArray(largest?.value) ? largest.value.slice(0, 10) : null;
      if (!values) return fail("rpc_unknown", "largest_accounts_unreadable", snapshot);
      const top10Raw = values.reduce((sum: bigint, row: any) => sum + BigInt(String(row.amount ?? "0")), 0n);
      const top10Pct = Number((top10Raw * 1_000_000n) / supply) / 10_000;
      snapshot.top10PctRaw = top10Pct;
      snapshot.top10TokenAccounts = values.map((row: any) => ({ address: row.address, amount: row.amount }));
      snapshot.s4Caveat = "Raw token-account concentration; pool/burn exclusions require S1/S6 provider enrichment before production enforcement.";
      if (top10Pct > TOP10_LIMIT_PCT) return fail("S4_top10_concentration", top10Pct, snapshot);
    }

    return { passed: true, checkFailed: null, observedValue: null, snapshot };
  } catch (error) {
    return fail("rpc_unknown", error instanceof Error ? error.message : String(error), snapshot);
  }
}

export function checkTokenSafety(mint: string): Promise<TokenSafetyResult> {
  const key = mint.trim();
  const existing = cache.get(key);
  if (existing) return existing;
  const task = evaluate(key);
  cache.set(key, task);
  return task;
}

export function clearTokenSafetyCacheForTests(): void {
  cache.clear();
}
