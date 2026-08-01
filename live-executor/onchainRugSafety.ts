import { PublicKey } from "@solana/web3.js";
import { getLiveConnection } from "../lib/liveWallet";
import { getSupabaseAdmin } from "../lib/supabase";

export const ONCHAIN_RUG_SAFETY_VERSION = "onchain_rug_safety_v1_2026_08_01";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const BURN_ADDRESSES = new Set(["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"]);
const MIN_SAFE_LP_PCT = Math.min(100, Math.max(50, Number(process.env.ONCHAIN_LP_MIN_SAFE_PCT) || 95));
const CACHE_UNKNOWN_MS = Math.max(60_000, Number(process.env.ONCHAIN_LP_UNKNOWN_CACHE_MS) || 10 * 60_000);
const CACHE_STATIC_MS = Math.max(60_000, Number(process.env.ONCHAIN_LP_STATIC_CACHE_MS) || 24 * 60 * 60_000);
const MAX_TRANSFER_FEE_BPS = Math.min(10_000, Math.max(0, Number(process.env.TOKEN2022_MAX_TRANSFER_FEE_BPS) || 300));

export type OnchainLpVerdict = "LOCKED" | "BURNED" | "CURVE" | "UNLOCKED" | "UNKNOWN";
export type OnchainLpResult = { verdict: OnchainLpVerdict; method: string; pool: string; lpMint: string | null; pctSafe: number | null; unlockAt: string | null; excludedAccounts: string[]; details: Record<string, unknown> };
export type TokenControlResult = { safe: boolean; reason: string | null; tokenProgram: string; details: Record<string, unknown> };

function n(value: unknown, fallback = 0): number { const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function lockerAllowlist(): Set<string> { return new Set((process.env.ONCHAIN_LP_LOCKER_ALLOWLIST ?? "").split(",").map((v) => v.trim()).filter(Boolean)); }
function extensionType(item: any): string { return String(item?.extension ?? item?.extensionType ?? item?.type ?? "").toLowerCase(); }

export async function resolveTokenControls(mintAddress: string): Promise<TokenControlResult> {
  const supabase = getSupabaseAdmin();
  const cached = await supabase.from("token_control_resolutions").select("*").eq("mint", mintAddress).maybeSingle();
  if (!cached.error && cached.data) return { safe: cached.data.safe, reason: cached.data.reason, tokenProgram: cached.data.token_program, details: cached.data.details ?? {} };
  const connection = getLiveConnection();
  const mint = new PublicKey(mintAddress);
  const parsed = await connection.getParsedAccountInfo(mint, "confirmed");
  if (!parsed.value) return { safe: false, reason: "mint_account_unreadable", tokenProgram: "unknown", details: {} };
  const tokenProgram = parsed.value.owner.toBase58();
  const info = (parsed.value.data as any)?.parsed?.info ?? {};
  const extensions = Array.isArray(info.extensions) ? info.extensions : [];
  const details: Record<string, unknown> = { version: ONCHAIN_RUG_SAFETY_VERSION, tokenProgram, extensions };
  let reason: string | null = null;
  if (info.mintAuthority) reason = "mint_authority_active";
  else if (info.freezeAuthority) reason = "freeze_authority_active";
  else if (tokenProgram === TOKEN_2022_PROGRAM) {
    for (const ext of extensions) {
      const type = extensionType(ext); const state = ext?.state ?? ext;
      if (type.includes("transferhook") && (state?.authority || state?.programId || state?.program_id)) { reason = "token2022_transfer_hook"; break; }
      if (type.includes("permanentdelegate") && (state?.delegate || state?.authority)) { reason = "token2022_permanent_delegate"; break; }
      if (type.includes("nontransferable")) { reason = "token2022_non_transferable"; break; }
      if (type.includes("transferfeeconfig")) {
        const newer = state?.newerTransferFee ?? state?.newer_transfer_fee ?? {}; const older = state?.olderTransferFee ?? state?.older_transfer_fee ?? {};
        const bps = Math.max(n(newer?.transferFeeBasisPoints ?? newer?.transfer_fee_basis_points), n(older?.transferFeeBasisPoints ?? older?.transfer_fee_basis_points));
        const authority = state?.transferFeeConfigAuthority ?? state?.transfer_fee_config_authority;
        if (authority) { reason = "token2022_mutable_transfer_fee"; break; }
        if (bps > MAX_TRANSFER_FEE_BPS) { reason = "token2022_transfer_fee_too_high"; break; }
      }
    }
  }
  const result = { safe: reason == null, reason, tokenProgram, details };
  await supabase.from("token_control_resolutions").upsert({ mint: mintAddress, token_program: tokenProgram, safe: result.safe, reason, details, resolved_at: new Date().toISOString() });
  return result;
}

async function raydiumPoolMetadata(pool: string): Promise<any | null> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8_000);
  try { const response = await fetch(`https://api-v3.raydium.io/pools/info/ids?ids=${encodeURIComponent(pool)}`, { signal: controller.signal, headers: { Accept: "application/json" } }); if (!response.ok) return null; const body = await response.json(); return body?.data?.[0] ?? body?.data?.data?.[0] ?? null; }
  catch { return null; } finally { clearTimeout(timer); }
}

export async function resolveOnchainLpSafety(input: { mint: string; pool: string; dexId?: string | null }): Promise<OnchainLpResult> {
  const supabase = getSupabaseAdmin();
  const cached = await supabase.from("lp_onchain_resolutions").select("*").eq("pool", input.pool).maybeSingle();
  if (!cached.error && cached.data && (!cached.data.expires_at || Date.parse(cached.data.expires_at) > Date.now())) return { verdict: cached.data.verdict, method: cached.data.method, pool: input.pool, lpMint: cached.data.lp_mint, pctSafe: cached.data.pct_safe == null ? null : n(cached.data.pct_safe), unlockAt: cached.data.unlock_at, excludedAccounts: cached.data.excluded_accounts ?? [], details: cached.data.details ?? {} };
  const connection = getLiveConnection();
  const poolKey = new PublicKey(input.pool); const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
  const poolProgram = poolInfo?.owner.toBase58() ?? null; const dex = String(input.dexId ?? "").toLowerCase();
  let verdict: OnchainLpVerdict = "UNKNOWN"; let method = "onchain_pool_unresolved"; let lpMint: string | null = null; let pctSafe: number | null = null;
  const excludedAccounts = new Set<string>([input.pool]); const details: Record<string, unknown> = { version: ONCHAIN_RUG_SAFETY_VERSION, dexId: input.dexId ?? null, poolProgram };
  if ((dex === "pumpfun" || dex === "pump.fun") && poolProgram === PUMP_PROGRAM) { verdict = "CURVE"; method = "pump_bonding_curve_program_owner"; }
  else {
    const ray = dex.includes("raydium") ? await raydiumPoolMetadata(input.pool) : null;
    lpMint = String(ray?.lpMint?.address ?? ray?.lpMint ?? ray?.lpMintAddress ?? "") || null;
    for (const value of [ray?.vaultA, ray?.vaultB, ray?.baseVault, ray?.quoteVault]) { const address = typeof value === "string" ? value : value?.address; if (address) excludedAccounts.add(String(address)); }
    if (lpMint) {
      const lpKey = new PublicKey(lpMint); const supplyResponse = await connection.getTokenSupply(lpKey, "confirmed"); const supply = BigInt(supplyResponse.value.amount);
      const largest = await connection.getTokenLargestAccounts(lpKey, "confirmed"); const lockers = lockerAllowlist(); let safeAmount = 0n; let eoaAmount = 0n; const holders: any[] = [];
      for (const item of largest.value) {
        const account = item.address.toBase58(); const amount = BigInt(item.amount); const accountInfo = await connection.getParsedAccountInfo(item.address, "confirmed");
        const owner = String((accountInfo.value?.data as any)?.parsed?.info?.owner ?? ""); const accountProgram = accountInfo.value?.owner.toBase58() ?? null;
        const burn = BURN_ADDRESSES.has(account) || BURN_ADDRESSES.has(owner); const locker = lockers.has(owner) || (accountProgram ? lockers.has(accountProgram) : false);
        if (burn || locker) safeAmount += amount; else eoaAmount += amount; holders.push({ account, owner, accountProgram, amount: amount.toString(), burn, locker });
      }
      pctSafe = supply > 0n ? Number((safeAmount * 10_000n) / supply) / 100 : 100; details.lpSupply = supply.toString(); details.lpHolders = holders;
      if (supply <= 10n || (pctSafe >= MIN_SAFE_LP_PCT && holders.some((h) => h.burn))) { verdict = "BURNED"; method = supply <= 10n ? "lp_supply_near_zero" : "dominant_lp_burn_holder"; }
      else if (pctSafe >= MIN_SAFE_LP_PCT && holders.some((h) => h.locker)) { verdict = "LOCKED"; method = "dominant_lp_known_locker"; }
      else if (eoaAmount > 0n && supply > 0n && Number((eoaAmount * 10_000n) / supply) / 100 > 100 - MIN_SAFE_LP_PCT) { verdict = "UNLOCKED"; method = "lp_controlled_by_withdrawable_accounts"; }
    }
  }
  const result: OnchainLpResult = { verdict, method, pool: input.pool, lpMint, pctSafe, unlockAt: null, excludedAccounts: [...excludedAccounts], details };
  const ttl = verdict === "UNKNOWN" ? CACHE_UNKNOWN_MS : CACHE_STATIC_MS;
  await supabase.from("lp_onchain_resolutions").upsert({ pool: input.pool, mint: input.mint, dex_id: input.dexId ?? null, pool_program: poolProgram, lp_mint: lpMint, verdict, method, pct_safe: pctSafe, excluded_accounts: result.excludedAccounts, details, resolved_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttl).toISOString() });
  return result;
}
