import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const EARLY_BLOCK_WINDOW = 5;
const FETCH_LIMIT = 60;
const RETRY_ERROR_AFTER_MS = 30 * 60_000;

export type ShadowCoinQuality = {
  mint: string;
  resolved: boolean;
  pass: boolean;
  creatorWallet: string | null;
  creationBlock: number | null;
  sameBlockBuyerCount: number | null;
  firstFiveBlockBuyerCount: number | null;
  bundleDetected: boolean | null;
  sniperDetected: boolean | null;
  reasons: string[];
  fetchedAt: string | null;
  error: string | null;
};

type TokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; uiAmountString?: string };
};

type FullTransaction = {
  slot?: number;
  transactionIndex?: number;
  blockTime?: number;
  transaction?: {
    message?: {
      header?: { numRequiredSignatures?: number };
      accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
    };
  };
  meta?: { preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] };
};

const inflight = new Map<string, Promise<ShadowCoinQuality>>();

function getApiKey(): string {
  const direct = process.env.HELIUS_API_KEY?.trim();
  if (direct) return direct;
  const rpc = process.env.HELIUS_RPC_URL?.trim();
  if (rpc) {
    const key = new URL(rpc).searchParams.get("api-key");
    if (key) return key;
  }
  throw new Error("HELIUS_API_KEY or HELIUS_RPC_URL is required for Shadow coin quality");
}

function rawAmount(balance: TokenBalance | undefined): bigint {
  const value = balance?.uiTokenAmount?.amount ?? "0";
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function accountKey(value: string | { pubkey?: string; signer?: boolean }): string {
  return typeof value === "string" ? value : String(value.pubkey ?? "");
}

function signerKeys(tx: FullTransaction): Set<string> {
  const message = tx.transaction?.message;
  const keys = message?.accountKeys ?? [];
  const explicit = keys
    .filter((key) => typeof key !== "string" && key.signer)
    .map(accountKey)
    .filter(Boolean);
  if (explicit.length > 0) return new Set(explicit);
  const required = Math.max(0, Number(message?.header?.numRequiredSignatures ?? 0));
  return new Set(keys.slice(0, required).map(accountKey).filter(Boolean));
}

function feePayer(tx: FullTransaction): string | null {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  return keys[0] ? accountKey(keys[0]) : null;
}

function positiveTokenOwners(tx: FullTransaction, mint: string): Set<string> {
  const pre = new Map<number, TokenBalance>();
  for (const balance of tx.meta?.preTokenBalances ?? []) {
    if (balance.mint === mint && balance.accountIndex != null) pre.set(balance.accountIndex, balance);
  }
  const signers = signerKeys(tx);
  const owners = new Set<string>();
  for (const post of tx.meta?.postTokenBalances ?? []) {
    if (post.mint !== mint || post.accountIndex == null || !post.owner) continue;
    const delta = rawAmount(post) - rawAmount(pre.get(post.accountIndex));
    if (delta > 0n && signers.has(post.owner)) owners.add(post.owner);
  }
  return owners;
}

async function fetchOldestTransactions(mint: string): Promise<FullTransaction[]> {
  const apiKey = getApiKey();
  const delays = [0, 2_000, 8_000];
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `shadow-coin-${mint.slice(0, 8)}`,
          method: "getTransactionsForAddress",
          params: [mint, {
            transactionDetails: "full",
            sortOrder: "asc",
            limit: FETCH_LIMIT,
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
            filters: { status: "succeeded" },
          }],
        }),
      });
      if (!response.ok) throw new Error(`Helius coin history HTTP ${response.status}`);
      const body = await response.json() as any;
      if (body.error) throw new Error(`Helius coin history RPC ${body.error.message ?? "error"}`);
      const rows = Array.isArray(body?.result) ? body.result : body?.result?.data;
      if (!Array.isArray(rows)) throw new Error("Helius coin history returned an invalid payload");
      return rows as FullTransaction[];
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = message.includes("429") || /HTTP 5\d\d/.test(message) || (error instanceof Error && error.name === "AbortError");
      if (!retryable || attempt === delays.length - 1) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function analyze(mint: string, transactions: FullTransaction[]): ShadowCoinQuality {
  const ordered = [...transactions]
    .filter((tx) => Number.isFinite(Number(tx.slot)))
    .sort(
      (a, b) =>
        Number(a.slot) - Number(b.slot) ||
        Number(a.transactionIndex ?? 0) - Number(b.transactionIndex ?? 0)
    );
  if (!ordered.length) throw new Error("token creation transaction not found");
  const creation = ordered[0];
  const creationBlock = Number(creation.slot);
  const creatorWallet = feePayer(creation);
  if (!Number.isFinite(creationBlock) || !creatorWallet) {
    throw new Error("token creation block or creator unresolved");
  }

  const sameBlockBuyers = new Set<string>();
  const firstFiveBuyers = new Set<string>();
  for (const tx of ordered) {
    const slot = Number(tx.slot);
    if (slot < creationBlock || slot > creationBlock + EARLY_BLOCK_WINDOW) continue;
    for (const owner of positiveTokenOwners(tx, mint)) {
      if (owner === creatorWallet) continue;
      if (slot === creationBlock) sameBlockBuyers.add(owner);
      else firstFiveBuyers.add(owner);
    }
  }

  const bundleDetected = sameBlockBuyers.size > 0;
  const sniperDetected = firstFiveBuyers.size > 0;
  const reasons = bundleDetected ? ["same_block_non_creator_buy_detected"] : [];
  return {
    mint,
    resolved: true,
    pass: !bundleDetected,
    creatorWallet,
    creationBlock,
    sameBlockBuyerCount: sameBlockBuyers.size,
    firstFiveBlockBuyerCount: firstFiveBuyers.size,
    bundleDetected,
    sniperDetected,
    reasons,
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

function fromRow(row: any): ShadowCoinQuality {
  const error = row.error_message ? String(row.error_message) : null;
  return {
    mint: String(row.mint),
    resolved: !error && row.creation_block != null && row.same_block_buyer_count != null,
    pass: Boolean(row.passed) && !error,
    creatorWallet: row.creator_wallet ? String(row.creator_wallet) : null,
    creationBlock: row.creation_block == null ? null : Number(row.creation_block),
    sameBlockBuyerCount: row.same_block_buyer_count == null ? null : Number(row.same_block_buyer_count),
    firstFiveBlockBuyerCount:
      row.first_five_block_buyer_count == null ? null : Number(row.first_five_block_buyer_count),
    bundleDetected: row.bundle_detected == null ? null : Boolean(row.bundle_detected),
    sniperDetected: row.sniper_detected == null ? null : Boolean(row.sniper_detected),
    reasons: Array.isArray(row.decision_reasons) ? row.decision_reasons.map(String) : [],
    fetchedAt: row.fetched_at ? String(row.fetched_at) : null,
    error,
  };
}

async function refresh(mint: string): Promise<ShadowCoinQuality> {
  const existing = inflight.get(mint);
  if (existing) return existing;
  const promise = (async () => {
    const fetchedAt = new Date().toISOString();
    try {
      const quality = analyze(mint, await fetchOldestTransactions(mint));
      const { data, error } = await supabase
        .from("shadow_coin_quality")
        .upsert({
          mint,
          creator_wallet: quality.creatorWallet,
          creation_block: quality.creationBlock,
          same_block_buyer_count: quality.sameBlockBuyerCount,
          first_five_block_buyer_count: quality.firstFiveBlockBuyerCount,
          bundle_detected: quality.bundleDetected,
          sniper_detected: quality.sniperDetected,
          passed: quality.pass,
          decision_reasons: quality.reasons,
          error_message: null,
          source: "helius_getTransactionsForAddress",
          fetched_at: fetchedAt,
          updated_at: fetchedAt,
        }, { onConflict: "mint" })
        .select("*")
        .single();
      if (error) throw new Error(`shadow coin quality upsert failed: ${error.message}`);
      return fromRow(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("shadow_coin_quality").upsert({
        mint,
        passed: false,
        decision_reasons: ["coin_quality_unresolved"],
        error_message: message,
        source: "helius_getTransactionsForAddress",
        fetched_at: fetchedAt,
        updated_at: fetchedAt,
      }, { onConflict: "mint" });
      return {
        mint,
        resolved: false,
        pass: false,
        creatorWallet: null,
        creationBlock: null,
        sameBlockBuyerCount: null,
        firstFiveBlockBuyerCount: null,
        bundleDetected: null,
        sniperDetected: null,
        reasons: ["coin_quality_unresolved"],
        fetchedAt,
        error: message,
      };
    }
  })().finally(() => inflight.delete(mint));
  inflight.set(mint, promise);
  return promise;
}

export async function loadShadowCoinQuality(mint: string): Promise<ShadowCoinQuality> {
  const { data, error } = await supabase
    .from("shadow_coin_quality")
    .select("*")
    .eq("mint", mint)
    .maybeSingle();
  if (error) throw new Error(`shadow coin quality cache read failed: ${error.message}`);
  if (data) {
    const quality = fromRow(data);
    const fetched = quality.fetchedAt ? Date.parse(quality.fetchedAt) : Number.NaN;
    if (quality.resolved) return quality;
    if (Number.isFinite(fetched) && Date.now() - fetched < RETRY_ERROR_AFTER_MS) return quality;
  }
  return refresh(mint);
}
