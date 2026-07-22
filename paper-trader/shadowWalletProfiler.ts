import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const EXCLUDED_MINTS = new Set([
  WRAPPED_SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const LAMPORTS_PER_SOL = 1_000_000_000;
const LOOKBACK_DAYS = 14;
const PROFILE_LIMIT = 100;
const CACHE_MS = 6 * 60 * 60_000;
const ERROR_RETRY_MS = 30 * 60_000;
const MIN_SAMPLE = 5;
const T_STAT_THRESHOLD = 1.645;

export type ShadowReturnStats = {
  n: number;
  mean: number | null;
  sd: number | null;
  tStat: number | null;
  recent1: number | null;
  recent1To5: number | null;
  recent6To10: number | null;
  recent11To15: number | null;
  returns: number[];
};

export type ShadowWalletQuality = {
  walletAddress: string;
  resolved: boolean;
  pass: boolean;
  reasons: string[];
  stats: ShadowReturnStats;
  observedSwaps: number;
  profiledAt: string | null;
  error: string | null;
};

type EnhancedTransaction = {
  feePayer?: string;
  fee?: number;
  timestamp?: number;
  nativeTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; amount?: number }>;
  tokenTransfers?: Array<{
    mint?: string;
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number;
  }>;
  accountData?: Array<{ account?: string; nativeBalanceChange?: number }>;
};

type ParsedSwap = { mint: string; timestamp: number; tokenDelta: number; solDelta: number };
type Holding = { quantity: number; costSol: number; cycleCostSol: number; cycleProceedsSol: number };

const inflight = new Map<string, Promise<ShadowWalletQuality>>();

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleSd(values: number[], average: number): number | null {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function calculateStats(returnsNewestFirst: number[]): ShadowReturnStats {
  const average = mean(returnsNewestFirst);
  const sd = average == null ? null : sampleSd(returnsNewestFirst, average);
  let tStat: number | null = null;
  if (average != null && returnsNewestFirst.length >= 2) {
    if (sd === 0) tStat = average > 0 ? 999 : average < 0 ? -999 : 0;
    else if (sd != null) tStat = average / (sd / Math.sqrt(returnsNewestFirst.length));
  }
  return {
    n: returnsNewestFirst.length,
    mean: average,
    sd,
    tStat,
    recent1: returnsNewestFirst[0] ?? null,
    recent1To5: mean(returnsNewestFirst.slice(0, 5)),
    recent6To10: mean(returnsNewestFirst.slice(5, 10)),
    recent11To15: mean(returnsNewestFirst.slice(10, 15)),
    returns: returnsNewestFirst.slice(0, 30),
  };
}

function walletNativeDelta(transaction: EnhancedTransaction, wallet: string): number {
  const accountEntry = transaction.accountData?.find((row) => row.account === wallet);
  if (accountEntry && Number.isFinite(Number(accountEntry.nativeBalanceChange))) {
    return finite(accountEntry.nativeBalanceChange) / LAMPORTS_PER_SOL;
  }
  let lamports = 0;
  for (const transfer of transaction.nativeTransfers ?? []) {
    const amount = finite(transfer.amount);
    if (transfer.toUserAccount === wallet) lamports += amount;
    if (transfer.fromUserAccount === wallet) lamports -= amount;
  }
  if (transaction.feePayer === wallet) lamports -= finite(transaction.fee);
  return lamports / LAMPORTS_PER_SOL;
}

function tokenDeltas(transaction: EnhancedTransaction, wallet: string): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const transfer of transaction.tokenTransfers ?? []) {
    const mint = transfer.mint?.trim();
    const amount = finite(transfer.tokenAmount);
    if (!mint || amount <= 0) continue;
    if (transfer.toUserAccount === wallet) deltas.set(mint, (deltas.get(mint) ?? 0) + amount);
    if (transfer.fromUserAccount === wallet) deltas.set(mint, (deltas.get(mint) ?? 0) - amount);
  }
  return deltas;
}

function parseSwap(transaction: EnhancedTransaction, wallet: string): ParsedSwap | null {
  const timestamp = finite(transaction.timestamp);
  if (timestamp <= 0) return null;
  const deltas = tokenDeltas(transaction, wallet);
  let solDelta = walletNativeDelta(transaction, wallet);
  if (Math.abs(solDelta) < 0.000001) solDelta = deltas.get(WRAPPED_SOL_MINT) ?? 0;
  const traded = [...deltas.entries()].filter(
    ([mint, delta]) => !EXCLUDED_MINTS.has(mint) && Math.abs(delta) > 1e-12
  );
  if (traded.length !== 1 || Math.abs(solDelta) < 0.000001) return null;
  const [mint, tokenDelta] = traded[0];
  const isBuy = tokenDelta > 0 && solDelta < 0;
  const isSell = tokenDelta < 0 && solDelta > 0;
  return isBuy || isSell ? { mint, timestamp, tokenDelta, solDelta } : null;
}

function profileTransactions(transactions: EnhancedTransaction[], wallet: string): {
  observedSwaps: number;
  stats: ShadowReturnStats;
} {
  const cutoffSec = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86_400;
  const swaps = transactions
    .map((transaction) => parseSwap(transaction, wallet))
    .filter((swap): swap is ParsedSwap => Boolean(swap))
    .filter((swap) => swap.timestamp >= cutoffSec)
    .sort((a, b) => a.timestamp - b.timestamp);

  const holdings = new Map<string, Holding>();
  const closedCycles: Array<{ mint: string; timestamp: number; costSol: number; proceedsSol: number }> = [];

  for (const swap of swaps) {
    if (swap.tokenDelta > 0) {
      const holding = holdings.get(swap.mint) ?? {
        quantity: 0,
        costSol: 0,
        cycleCostSol: 0,
        cycleProceedsSol: 0,
      };
      const cost = Math.abs(swap.solDelta);
      holding.quantity += swap.tokenDelta;
      holding.costSol += cost;
      holding.cycleCostSol += cost;
      holdings.set(swap.mint, holding);
      continue;
    }

    const holding = holdings.get(swap.mint);
    const soldQuantity = Math.abs(swap.tokenDelta);
    if (!holding || holding.quantity <= 0 || holding.costSol <= 0) continue;
    const matchedQuantity = Math.min(soldQuantity, holding.quantity);
    const holdingFraction = matchedQuantity / holding.quantity;
    const saleFraction = matchedQuantity / soldQuantity;
    const cost = holding.costSol * holdingFraction;
    const proceeds = swap.solDelta * saleFraction;
    holding.quantity -= matchedQuantity;
    holding.costSol -= cost;
    holding.cycleProceedsSol += proceeds;

    if (holding.quantity <= 1e-12 || holding.costSol <= 1e-12) {
      if (holding.cycleCostSol > 0) {
        closedCycles.push({
          mint: swap.mint,
          timestamp: swap.timestamp,
          costSol: holding.cycleCostSol,
          proceedsSol: holding.cycleProceedsSol,
        });
      }
      holdings.delete(swap.mint);
    } else {
      holdings.set(swap.mint, holding);
    }
  }

  const perCoin = new Map<string, { timestamp: number; costSol: number; proceedsSol: number }>();
  for (const cycle of closedCycles) {
    const current = perCoin.get(cycle.mint) ?? { timestamp: 0, costSol: 0, proceedsSol: 0 };
    current.timestamp = Math.max(current.timestamp, cycle.timestamp);
    current.costSol += cycle.costSol;
    current.proceedsSol += cycle.proceedsSol;
    perCoin.set(cycle.mint, current);
  }
  const returns = [...perCoin.values()]
    .filter((coin) => coin.costSol > 0)
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((coin) => coin.proceedsSol / coin.costSol - 1)
    .filter(Number.isFinite);
  return { observedSwaps: swaps.length, stats: calculateStats(returns) };
}

function getApiKey(): string {
  const direct = process.env.HELIUS_API_KEY?.trim();
  if (direct) return direct;
  const rpc = process.env.HELIUS_RPC_URL?.trim();
  if (rpc) {
    const key = new URL(rpc).searchParams.get("api-key");
    if (key) return key;
  }
  throw new Error("HELIUS_API_KEY or HELIUS_RPC_URL is required for Shadow wallet quality");
}

async function fetchTransactions(wallet: string): Promise<EnhancedTransaction[]> {
  const key = getApiKey();
  const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86_400;
  const url =
    `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(wallet)}/transactions` +
    `?api-key=${encodeURIComponent(key)}&type=SWAP&limit=${PROFILE_LIMIT}` +
    `&token-accounts=balanceChanged&gte-time=${cutoff}`;
  const delays = [0, 2_000, 8_000];
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Helius wallet profile HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error("Helius wallet profile returned an invalid payload");
      return body as EnhancedTransaction[];
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

function reasonsFor(stats: ShadowReturnStats): string[] {
  const reasons: string[] = [];
  if (stats.n < MIN_SAMPLE) reasons.push(`wallet_sample_below_${MIN_SAMPLE}`);
  if (stats.tStat == null) reasons.push("wallet_t_stat_unresolved");
  else if (stats.tStat <= T_STAT_THRESHOLD) reasons.push(`wallet_t_stat_at_or_below_${T_STAT_THRESHOLD}`);
  if (stats.recent1To5 == null) reasons.push("wallet_recent_5_unresolved");
  else if (stats.recent1To5 <= 0) reasons.push("wallet_recent_5_not_positive");
  return reasons;
}

function fromRow(row: any): ShadowWalletQuality {
  const stats: ShadowReturnStats = {
    n: finite(row.return_count),
    mean: row.mean_return == null ? null : finite(row.mean_return),
    sd: row.return_sd == null ? null : finite(row.return_sd),
    tStat: row.t_stat == null ? null : finite(row.t_stat),
    recent1: row.recent_1 == null ? null : finite(row.recent_1),
    recent1To5: row.recent_1_5 == null ? null : finite(row.recent_1_5),
    recent6To10: row.recent_6_10 == null ? null : finite(row.recent_6_10),
    recent11To15: row.recent_11_15 == null ? null : finite(row.recent_11_15),
    returns: Array.isArray(row.returns) ? row.returns.map(Number).filter(Number.isFinite) : [],
  };
  const error = row.error_message ? String(row.error_message) : null;
  const reasons = error ? ["wallet_quality_unresolved"] : reasonsFor(stats);
  return {
    walletAddress: String(row.wallet_address),
    resolved: !error,
    pass: !error && reasons.length === 0,
    reasons,
    stats,
    observedSwaps: finite(row.observed_swaps),
    profiledAt: row.profiled_at ? String(row.profiled_at) : null,
    error,
  };
}

async function refreshOne(wallet: string): Promise<ShadowWalletQuality> {
  const existing = inflight.get(wallet);
  if (existing) return existing;
  const promise = (async () => {
    const profiledAt = new Date().toISOString();
    try {
      const transactions = await fetchTransactions(wallet);
      const profile = profileTransactions(transactions, wallet);
      const reasons = reasonsFor(profile.stats);
      const { data, error } = await supabase
        .from("shadow_wallet_quality")
        .upsert({
          wallet_address: wallet,
          profile_version: 1,
          lookback_days: LOOKBACK_DAYS,
          observed_swaps: profile.observedSwaps,
          return_count: profile.stats.n,
          mean_return: profile.stats.mean,
          return_sd: profile.stats.sd,
          t_stat: profile.stats.tStat,
          recent_1: profile.stats.recent1,
          recent_1_5: profile.stats.recent1To5,
          recent_6_10: profile.stats.recent6To10,
          recent_11_15: profile.stats.recent11To15,
          returns: profile.stats.returns,
          passed: reasons.length === 0,
          decision_reasons: reasons,
          error_message: null,
          profiled_at: profiledAt,
          updated_at: profiledAt,
        }, { onConflict: "wallet_address" })
        .select("*")
        .single();
      if (error) throw new Error(`shadow wallet quality upsert failed: ${error.message}`);
      return fromRow(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("shadow_wallet_quality").upsert({
        wallet_address: wallet,
        profile_version: 1,
        lookback_days: LOOKBACK_DAYS,
        passed: false,
        decision_reasons: ["wallet_quality_unresolved"],
        error_message: message,
        profiled_at: profiledAt,
        updated_at: profiledAt,
      }, { onConflict: "wallet_address" });
      return {
        walletAddress: wallet,
        resolved: false,
        pass: false,
        reasons: ["wallet_quality_unresolved"],
        stats: calculateStats([]),
        observedSwaps: 0,
        profiledAt,
        error: message,
      };
    }
  })().finally(() => inflight.delete(wallet));
  inflight.set(wallet, promise);
  return promise;
}

export async function loadShadowWalletQualities(addresses: string[]): Promise<ShadowWalletQuality[]> {
  const unique = [...new Set(addresses.filter(Boolean))];
  if (!unique.length) return [];
  const { data, error } = await supabase
    .from("shadow_wallet_quality")
    .select("*")
    .in("wallet_address", unique);
  if (error) throw new Error(`shadow wallet quality cache read failed: ${error.message}`);
  const rows = new Map<string, any>(((data ?? []) as any[]).map((row: any) => [String(row.wallet_address), row]));

  return Promise.all(unique.map(async (wallet) => {
    const row = rows.get(wallet);
    const timestamp = row?.profiled_at ? Date.parse(String(row.profiled_at)) : Number.NaN;
    const ageMs = Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
    const freshSuccess = ageMs <= CACHE_MS && !row?.error_message;
    const freshError = ageMs <= ERROR_RETRY_MS && Boolean(row?.error_message);
    return freshSuccess || freshError ? fromRow(row) : refreshOne(wallet);
  }));
}
