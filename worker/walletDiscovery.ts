import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();

const DISCOVERY_SOURCE = "helius_seed_token_cotrader";
const PROFILE_MAX_SWAPS = 50;
const PROFILE_LOOKBACK_DAYS = 14;
const MIN_OBSERVED_SWAPS = 15;
const MIN_MEDIAN_ENTRY_DELAY_MIN = 60;
const TRIAL_MIN_MEDIAN_ENTRY_DELAY_MIN = 120;
const MAX_PCT_BUYS_UNDER_30_MIN = 0.5;
const MAX_SWAP_FREQUENCY_PER_DAY = 200;
const CHURN_PROFILE_VERSION = 2;
const MAX_DISTINCT_TOKEN_CREATION_LOOKUPS = 24;
const PROFILE_WALLET_DELAY_MS = 2_000;
const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
const MAX_CANDIDATES_TO_PROFILE = 12;

const DISCOVERY_INTERVAL_HOURS = boundedNumber(process.env.WALLET_DISCOVERY_INTERVAL_HOURS, 24, 1, 24);
const MAX_NEW_PER_RUN = Math.floor(boundedNumber(process.env.WALLET_DISCOVERY_MAX_NEW, 3, 1, 5));
const MAX_ACTIVE_TRIALS = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_MAX_ACTIVE_TRIALS, 20, 5, 40)
);
const SEED_TOKEN_LIMIT = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_SEED_TOKENS, 6, 2, 10)
);
const TRANSACTIONS_PER_TOKEN = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_TXS_PER_TOKEN, 20, 5, 50)
);
const MIN_SEED_SCORE = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_MIN_SEED_SCORE, 8, 6, 20)
);
const REQUEST_TIMEOUT_MS = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_TIMEOUT_MS, 15_000, 3_000, 60_000)
);

const EXCLUDED_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "So11111111111111111111111111111111111111111",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

interface SeedToken {
  token_mint: string;
  token_symbol: string | null;
  score: number | string;
}

interface TokenTransfer {
  mint?: string;
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
}

interface EnhancedTransaction {
  feePayer?: string;
  signature?: string;
  timestamp?: number;
  tokenTransfers?: TokenTransfer[];
}

interface SeedCandidate {
  address: string;
  tokenCount: number;
  transactionCount: number;
  seedScoreTotal: number;
  maxSeedScore: number;
  seedTokens: string[];
}

interface ReasonCounts {
  creation_ts_not_found: number;
  not_a_buy: number;
  parse_error: number;
}

interface EntryTimingProfile {
  medianEntryDelayMin: number | null;
  pctBuysUnder30Min: number | null;
  observedSwapCount: number;
  distinctTokenCount: number;
  profiledBuyCount: number;
  swapFrequencyPerDay: number;
  observationWindowHours: number;
  unprofiledReasonCounts: ReasonCounts;
  discoveryScore: number;
  rejectionReasons: string[];
}

interface ProfiledCandidate extends SeedCandidate {
  profile: EntryTimingProfile;
}

class HttpStatusError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
  }
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSolanaAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function getHeliusApiKey(): string {
  const explicit = process.env.HELIUS_API_KEY?.trim();
  if (explicit) return explicit;
  const rpcUrl = process.env.HELIUS_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("HELIUS_RPC_URL is required for wallet discovery");
  try {
    const key = new URL(rpcUrl).searchParams.get("api-key");
    if (key) return key;
  } catch {
    // Safe configuration error below.
  }
  throw new Error("Could not read Helius API key; set HELIUS_API_KEY or HELIUS_RPC_URL");
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function isRetryable(error: unknown): boolean {
  return error instanceof HttpStatusError && (error.status === 429 || error.status >= 500);
}

async function fetchJsonOnce(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 160).replace(/\s+/g, " ");
      throw new HttpStatusError(response.status, `HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetchJsonOnce(url);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

async function loadSeedTokens(): Promise<SeedToken[]> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("token_scores")
    .select("token_mint, token_symbol, score")
    .gte("score", MIN_SEED_SCORE)
    .eq("dump_flag", false)
    .gte("liquidity_usd", 10_000)
    .gte("updated_at", cutoff)
    .order("score", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(SEED_TOKEN_LIMIT);
  if (error) throw new Error(`Failed to load discovery seed tokens: ${error.message}`);
  return ((data ?? []) as SeedToken[]).filter((row) => isSolanaAddress(row.token_mint));
}

async function fetchEnhancedTransactions(
  address: string,
  apiKey: string,
  limit: number
): Promise<EnhancedTransaction[]> {
  const safeLimit = Math.min(PROFILE_MAX_SWAPS, Math.max(1, Math.floor(limit)));
  const url =
    `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions` +
    `?api-key=${encodeURIComponent(apiKey)}&type=SWAP&limit=${safeLimit}`;
  const payload = await fetchJsonWithRetry(url);
  if (!Array.isArray(payload)) throw new Error("Helius returned an unexpected discovery response");
  return payload as EnhancedTransaction[];
}

async function fetchCreationTimestamps(mints: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  for (const mint of mints) result.set(mint, null);
  if (mints.length === 0) return result;

  for (let offset = 0; offset < mints.length; offset += 30) {
    const batch = mints.slice(offset, offset + 30);
    try {
      const payload = await fetchJsonWithRetry(
        `https://api.dexscreener.com/tokens/v1/solana/${batch.map(encodeURIComponent).join(",")}`
      );
      if (!Array.isArray(payload)) continue;
      for (const pair of payload as Array<{ baseToken?: { address?: string }; pairCreatedAt?: unknown }>) {
        const mint = pair.baseToken?.address;
        const createdMs = Number(pair.pairCreatedAt);
        if (!mint || !Number.isFinite(createdMs) || createdMs <= 0) continue;
        const createdSec = Math.floor(createdMs / 1000);
        const current = result.get(mint);
        if (current == null || createdSec < current) result.set(mint, createdSec);
      }
    } catch (error) {
      if (isRetryable(error)) throw error;
      console.warn("[wallet-discovery] creation timestamp batch lookup failed:", error);
    }
    if (offset + 30 < mints.length) await sleep(500);
  }
  return result;
}

function extractBoughtMints(transaction: EnhancedTransaction, wallet: string): string[] {
  const bought = new Set<string>();
  for (const transfer of transaction.tokenTransfers ?? []) {
    const mint = transfer.mint?.trim();
    if (!mint || EXCLUDED_MINTS.has(mint) || !isSolanaAddress(mint)) continue;
    if (transfer.toUserAccount !== wallet || transfer.fromUserAccount === wallet) continue;
    if (Number(transfer.tokenAmount ?? 0) <= 0) continue;
    bought.add(mint);
  }
  return [...bought];
}

function timingRejectionReasons(profile: EntryTimingProfile): string[] {
  const reasons: string[] = [];
  if (profile.observedSwapCount < MIN_OBSERVED_SWAPS) {
    reasons.push(`insufficient_observed_swaps:${profile.observedSwapCount}<${MIN_OBSERVED_SWAPS}`);
  }
  if (profile.medianEntryDelayMin == null) {
    reasons.push("missing_entry_timing_data");
  } else if (profile.medianEntryDelayMin < MIN_MEDIAN_ENTRY_DELAY_MIN) {
    reasons.push(`median_entry_delay_too_low:${profile.medianEntryDelayMin.toFixed(2)}<60`);
  }
  if (profile.pctBuysUnder30Min == null) {
    reasons.push("missing_under_30m_share");
  } else if (profile.pctBuysUnder30Min > MAX_PCT_BUYS_UNDER_30_MIN) {
    reasons.push(`launch_sniper_share_too_high:${profile.pctBuysUnder30Min.toFixed(4)}>0.5`);
  }
  if (profile.swapFrequencyPerDay > MAX_SWAP_FREQUENCY_PER_DAY) {
    reasons.push("churn_above_200_per_day");
  }
  return reasons;
}

function scoreProfile(profile: Omit<EntryTimingProfile, "discoveryScore" | "rejectionReasons">): number {
  let score = 0;
  const medianDelay = profile.medianEntryDelayMin;
  if (medianDelay != null) {
    if (medianDelay >= 120 && medianDelay <= 720) score += 600;
    else if (medianDelay >= 60) score += 250;
    if (medianDelay > 1_440) score -= 100;
  }
  score += Math.min(180, profile.distinctTokenCount * 30);
  score += Math.min(100, profile.observedSwapCount * 4);
  if (profile.pctBuysUnder30Min != null) score -= Math.round(profile.pctBuysUnder30Min * 500);
  if (profile.swapFrequencyPerDay > 20) {
    score -= Math.min(250, Math.round((profile.swapFrequencyPerDay - 20) * 8));
  }
  return Math.max(0, score);
}

async function buildEntryTimingProfile(address: string, apiKey: string): Promise<EntryTimingProfile> {
  const cutoffSec = Math.floor(Date.now() / 1000) - PROFILE_LOOKBACK_DAYS * 86_400;
  const transactions = (await fetchEnhancedTransactions(address, apiKey, PROFILE_MAX_SWAPS))
    .filter((transaction) => Number(transaction.timestamp ?? 0) >= cutoffSec)
    .slice(0, PROFILE_MAX_SWAPS);

  const reasons: ReasonCounts = { creation_ts_not_found: 0, not_a_buy: 0, parse_error: 0 };
  const buysByMint = new Map<string, number[]>();
  const transactionBuys: Array<{ timestamp: number; mints: string[] }> = [];

  for (const transaction of transactions) {
    const timestamp = Number(transaction.timestamp ?? 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      reasons.parse_error += 1;
      continue;
    }
    try {
      const mints = extractBoughtMints(transaction, address);
      if (mints.length === 0) {
        reasons.not_a_buy += 1;
        continue;
      }
      transactionBuys.push({ timestamp, mints });
      for (const mint of mints) {
        const values = buysByMint.get(mint) ?? [];
        values.push(timestamp);
        buysByMint.set(mint, values);
      }
    } catch {
      reasons.parse_error += 1;
    }
  }

  const prioritizedMints = [...buysByMint.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_DISTINCT_TOKEN_CREATION_LOOKUPS)
    .map(([mint]) => mint);
  const creationByMint = await fetchCreationTimestamps(prioritizedMints);

  for (const mint of prioritizedMints) {
    if (creationByMint.get(mint) == null) {
      const earliestObserved = Math.min(...(buysByMint.get(mint) ?? []));
      if (Number.isFinite(earliestObserved)) creationByMint.set(mint, earliestObserved);
    }
  }

  const delays: number[] = [];
  for (const buy of transactionBuys) {
    let profiledThisSwap = false;
    for (const mint of buy.mints) {
      const created = creationByMint.get(mint);
      if (created == null) continue;
      delays.push(Math.max(0, (buy.timestamp - created) / 60));
      profiledThisSwap = true;
    }
    if (!profiledThisSwap) reasons.creation_ts_not_found += 1;
  }

  const validTimestamps = transactions
    .map((tx) => Number(tx.timestamp ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const observationWindowHours =
    validTimestamps.length > 1
      ? (Math.max(...validTimestamps) - Math.min(...validTimestamps)) / 3_600
      : 0;
  const swapFrequencyPerDay =
    observationWindowHours > 0
      ? transactions.length / (observationWindowHours / 24)
      : transactions.length > 1
        ? Number.MAX_SAFE_INTEGER
        : 0;
  const medianEntryDelayMin = median(delays);
  const pctBuysUnder30Min =
    delays.length > 0 ? delays.filter((delay) => delay < 30).length / delays.length : null;

  const base = {
    medianEntryDelayMin,
    pctBuysUnder30Min,
    observedSwapCount: transactions.length,
    distinctTokenCount: buysByMint.size,
    profiledBuyCount: delays.length,
    swapFrequencyPerDay,
    observationWindowHours,
    unprofiledReasonCounts: reasons,
  };
  const profile: EntryTimingProfile = {
    ...base,
    discoveryScore: scoreProfile(base),
    rejectionReasons: [],
  };
  profile.rejectionReasons = timingRejectionReasons(profile);
  return profile;
}

function metricsFor(candidate: SeedCandidate, profile: EntryTimingProfile): Record<string, unknown> {
  return {
    median_entry_delay_min:
      profile.medianEntryDelayMin == null ? null : Number(profile.medianEntryDelayMin.toFixed(2)),
    pct_buys_under_30min:
      profile.pctBuysUnder30Min == null ? null : Number(profile.pctBuysUnder30Min.toFixed(4)),
    observed_swap_count: profile.observedSwapCount,
    distinct_token_count: profile.distinctTokenCount,
    profiled_buy_count: profile.profiledBuyCount,
    swap_frequency_per_day: Number(profile.swapFrequencyPerDay.toFixed(2)),
    observation_window_hours: Number(profile.observationWindowHours.toFixed(4)),
    churn_profile_version: CHURN_PROFILE_VERSION,
    unprofiled_reason_counts: profile.unprofiledReasonCounts,
    seed_token_count: candidate.tokenCount,
    seed_score_total: candidate.seedScoreTotal,
    max_seed_score: candidate.maxSeedScore,
    discovery_score: profile.discoveryScore,
    seed_tokens: candidate.seedTokens,
    profile_pending_retry: false,
    profiled_at: new Date().toISOString(),
  };
}

async function logDiscoveryRejection(
  address: string,
  stage: "candidate" | "retroactive_trial" | "trial_promotion",
  reasons: string[],
  metrics: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("wallet_discovery_rejections").insert({
    wallet_address: address,
    discovery_source: DISCOVERY_SOURCE,
    rejection_stage: stage,
    skip_reasons: reasons,
    filter_snapshot: metrics,
  });
  if (error) console.error(`[wallet-discovery] failed to log rejection for ${address}:`, error.message);
}

async function markProfilePendingRetry(
  address: string,
  previousMetrics: Record<string, unknown>,
  error: unknown
): Promise<void> {
  const metrics = {
    ...previousMetrics,
    profile_pending_retry: true,
    profile_retry_error: error instanceof Error ? error.message : String(error),
    profile_retry_marked_at: new Date().toISOString(),
  };
  const { error: updateError } = await supabase
    .from("wallets")
    .update({ discovery_metrics: metrics, management_updated_at: new Date().toISOString() })
    .eq("address", address)
    .eq("discovery_source", DISCOVERY_SOURCE);
  if (updateError) throw new Error(`Failed to mark profile retry: ${updateError.message}`);
}

async function fetchSeedCandidates(): Promise<SeedCandidate[]> {
  const [seedTokens, apiKey] = await Promise.all([loadSeedTokens(), Promise.resolve(getHeliusApiKey())]);
  if (seedTokens.length === 0) return [];
  const evidence = new Map<
    string,
    { tokens: Set<string>; transactionCount: number; seedScoreTotal: number; maxSeedScore: number }
  >();

  for (const seed of seedTokens) {
    try {
      const transactions = await fetchEnhancedTransactions(seed.token_mint, apiKey, TRANSACTIONS_PER_TOKEN);
      const seenForSeed = new Set<string>();
      const seedScore = Number(seed.score) || 0;
      for (const transaction of transactions) {
        const address = transaction.feePayer?.trim();
        if (!address || !isSolanaAddress(address)) continue;
        const current = evidence.get(address) ?? {
          tokens: new Set<string>(),
          transactionCount: 0,
          seedScoreTotal: 0,
          maxSeedScore: 0,
        };
        current.transactionCount += 1;
        current.maxSeedScore = Math.max(current.maxSeedScore, seedScore);
        if (!seenForSeed.has(address)) {
          current.tokens.add(seed.token_mint);
          current.seedScoreTotal += seedScore;
          seenForSeed.add(address);
        }
        evidence.set(address, current);
      }
    } catch (error) {
      console.warn(`[wallet-discovery] seed ${seed.token_mint.slice(0, 6)}… skipped:`, error);
    }
  }

  return [...evidence.entries()]
    .map(([address, row]) => ({
      address,
      tokenCount: row.tokens.size,
      transactionCount: row.transactionCount,
      seedScoreTotal: row.seedScoreTotal,
      maxSeedScore: row.maxSeedScore,
      seedTokens: [...row.tokens],
    }))
    .sort(
      (a, b) =>
        b.tokenCount * 100 + b.seedScoreTotal * 3 + b.transactionCount -
        (a.tokenCount * 100 + a.seedScoreTotal * 3 + a.transactionCount)
    );
}

async function profileCandidates(candidates: SeedCandidate[]): Promise<ProfiledCandidate[]> {
  const apiKey = getHeliusApiKey();
  const profiled: ProfiledCandidate[] = [];
  for (const candidate of candidates.slice(0, MAX_CANDIDATES_TO_PROFILE)) {
    try {
      const profile = await buildEntryTimingProfile(candidate.address, apiKey);
      const metrics = metricsFor(candidate, profile);
      if (profile.rejectionReasons.length > 0) {
        await logDiscoveryRejection(candidate.address, "candidate", profile.rejectionReasons, metrics);
      } else {
        profiled.push({ ...candidate, profile });
      }
    } catch (error) {
      console.warn(`[wallet-discovery] candidate profile pending retry ${candidate.address}:`, error);
    }
    await sleep(PROFILE_WALLET_DELAY_MS);
  }
  return profiled.sort((a, b) => b.profile.discoveryScore - a.profile.discoveryScore);
}

function candidateFromRow(row: { address: string; discovery_metrics: unknown }): SeedCandidate {
  const prior = (row.discovery_metrics ?? {}) as Record<string, unknown>;
  return {
    address: row.address,
    tokenCount: Number(prior.seed_token_count ?? 0),
    transactionCount: Number(prior.observed_swap_count ?? 0),
    seedScoreTotal: Number(prior.seed_score_total ?? 0),
    maxSeedScore: Number(prior.max_seed_score ?? 0),
    seedTokens: Array.isArray(prior.seed_tokens) ? (prior.seed_tokens as string[]) : [],
  };
}

async function reevaluateExistingTrials(): Promise<void> {
  const { data, error } = await supabase
    .from("wallets")
    .select("address, active, management_status, auto_disable_reason, discovery_metrics")
    .eq("discovery_source", DISCOVERY_SOURCE)
    .or(
      "active.eq.true,management_status.eq.trial,discovery_metrics->>profile_pending_retry.eq.true,auto_disable_reason.like.retroactive_profile_error:%"
    );
  if (error) throw new Error(`Failed to load discovery trials: ${error.message}`);

  const apiKey = getHeliusApiKey();
  for (const row of data ?? []) {
    const prior = (row.discovery_metrics ?? {}) as Record<string, unknown>;
    const profileCurrent =
      prior.profile_pending_retry !== true &&
      Number(prior.churn_profile_version ?? 0) >= CHURN_PROFILE_VERSION &&
      typeof prior.unprofiled_reason_counts === "object" &&
      !String(row.auto_disable_reason ?? "").startsWith("retroactive_profile_error:");
    if (profileCurrent) continue;

    const candidate = candidateFromRow(row);
    try {
      const profile = await buildEntryTimingProfile(row.address, apiKey);
      const metrics = metricsFor(candidate, profile);
      const reasons = [...profile.rejectionReasons];
      if (profile.medianEntryDelayMin != null && profile.medianEntryDelayMin < TRIAL_MIN_MEDIAN_ENTRY_DELAY_MIN) {
        reasons.push(`trial_median_entry_delay_too_low:${profile.medianEntryDelayMin.toFixed(2)}<120`);
      }

      if (reasons.length > 0) {
        await supabase
          .from("wallets")
          .update({
            active: false,
            management_status: "disabled",
            auto_disabled_at: new Date().toISOString(),
            auto_disable_reason: `discovery_entry_timing_rejected:${reasons.join("|")}`,
            management_updated_at: new Date().toISOString(),
            discovery_metrics: metrics,
          })
          .eq("address", row.address)
          .eq("discovery_source", DISCOVERY_SOURCE);
        await logDiscoveryRejection(row.address, "retroactive_trial", reasons, metrics);
      } else {
        await supabase
          .from("wallets")
          .update({
            active: true,
            management_status: "trial",
            auto_disabled_at: null,
            auto_disable_reason: null,
            management_updated_at: new Date().toISOString(),
            discovery_metrics: metrics,
          })
          .eq("address", row.address)
          .eq("discovery_source", DISCOVERY_SOURCE);
      }
    } catch (profileError) {
      await markProfilePendingRetry(row.address, prior, profileError);
    }
    await sleep(PROFILE_WALLET_DELAY_MS);
  }
}

export async function discoverTrialWallets(): Promise<{
  fetched: number;
  eligible: number;
  added: string[];
}> {
  await reevaluateExistingTrials();
  const seedCandidates = await fetchSeedCandidates();
  const candidates = await profileCandidates(seedCandidates);

  const [{ data: existingRows, error: existingError }, { count: activeTrialCount, error: countError }] =
    await Promise.all([
      supabase.from("wallets").select("address"),
      supabase
        .from("wallets")
        .select("id", { count: "exact", head: true })
        .eq("active", true)
        .eq("management_status", "trial"),
    ]);
  if (existingError) throw new Error(`Failed to load existing wallets: ${existingError.message}`);
  if (countError) throw new Error(`Failed to count trial wallets: ${countError.message}`);

  const existing = new Set((existingRows ?? []).map((row) => row.address));
  const availableSlots = Math.max(0, MAX_ACTIVE_TRIALS - (activeTrialCount ?? 0));
  const promotionEligible = candidates.filter(
    (candidate) =>
      candidate.profile.medianEntryDelayMin != null &&
      candidate.profile.medianEntryDelayMin >= TRIAL_MIN_MEDIAN_ENTRY_DELAY_MIN
  );

  for (const candidate of candidates) {
    if (
      candidate.profile.medianEntryDelayMin != null &&
      candidate.profile.medianEntryDelayMin < TRIAL_MIN_MEDIAN_ENTRY_DELAY_MIN
    ) {
      await logDiscoveryRejection(
        candidate.address,
        "trial_promotion",
        [`trial_median_entry_delay_too_low:${candidate.profile.medianEntryDelayMin.toFixed(2)}<120`],
        metricsFor(candidate, candidate.profile)
      );
    }
  }

  const selected = promotionEligible
    .filter((candidate) => !existing.has(candidate.address))
    .slice(0, Math.min(MAX_NEW_PER_RUN, availableSlots));
  if (selected.length === 0) {
    return { fetched: seedCandidates.length, eligible: promotionEligible.length, added: [] };
  }

  const discoveredAt = new Date().toISOString();
  const rows = selected.map((candidate, index) => ({
    address: candidate.address,
    label: `Helius Trial ${discoveredAt.slice(0, 10)} #${index + 1}`,
    active: true,
    management_status: "trial",
    discovery_source: DISCOVERY_SOURCE,
    discovered_at: discoveredAt,
    discovery_metrics: metricsFor(candidate, candidate.profile),
  }));
  const { data, error } = await supabase.from("wallets").insert(rows).select("address");
  if (error) throw new Error(`Failed to insert trial wallets: ${error.message}`);
  const added = (data ?? []).map((row) => row.address);
  console.log(`[wallet-discovery] added ${added.length} timing-qualified trial wallet(s)`);
  return { fetched: seedCandidates.length, eligible: promotionEligible.length, added };
}

let running = false;

export function startWalletDiscoveryScheduler(): void {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await discoverTrialWallets();
    } catch (error) {
      console.error("[wallet-discovery] skipped safely:", error);
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(() => void run(), DISCOVERY_INTERVAL_HOURS * 3_600_000);
  console.log(
    `[wallet-discovery] enabled every ${DISCOVERY_INTERVAL_HOURS}h; profile cap ${PROFILE_MAX_SWAPS}; ` +
      `wallet delay ${PROFILE_WALLET_DELAY_MS}ms; churn cap ${MAX_SWAP_FREQUENCY_PER_DAY}/day`
  );
}
