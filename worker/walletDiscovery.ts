import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();

const DISCOVERY_INTERVAL_HOURS = boundedNumber(
  process.env.WALLET_DISCOVERY_INTERVAL_HOURS,
  6,
  1,
  24
);
const MAX_NEW_PER_RUN = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_MAX_NEW, 3, 1, 5)
);
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

interface SeedToken {
  token_mint: string;
  token_symbol: string | null;
  score: number | string;
}

interface EnhancedTransaction {
  feePayer?: string;
  source?: string;
  type?: string;
  signature?: string;
  timestamp?: number;
}

interface Candidate {
  address: string;
  tokenCount: number;
  transactionCount: number;
  seedScoreTotal: number;
  maxSeedScore: number;
  score: number;
  seedTokens: string[];
}

function boundedNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
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
  if (!rpcUrl) {
    throw new Error("HELIUS_RPC_URL is required for wallet discovery");
  }

  try {
    const parsed = new URL(rpcUrl);
    const key = parsed.searchParams.get("api-key");
    if (key) return key;
  } catch {
    // Report a safe configuration error below.
  }

  throw new Error(
    "Could not read the Helius API key from HELIUS_RPC_URL; optionally set HELIUS_API_KEY"
  );
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
  mint: string,
  apiKey: string
): Promise<EnhancedTransaction[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url =
    `https://api-mainnet.helius-rpc.com/v0/addresses/${mint}/transactions` +
    `?api-key=${encodeURIComponent(apiKey)}` +
    `&type=SWAP&limit=${TRANSACTIONS_PER_TOKEN}`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 160).replace(/\s+/g, " ");
      throw new Error(`Helius returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error("Helius returned an unexpected wallet-discovery response");
    }

    return payload as EnhancedTransaction[];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCandidates(): Promise<Candidate[]> {
  const [seedTokens, apiKey] = await Promise.all([
    loadSeedTokens(),
    Promise.resolve(getHeliusApiKey()),
  ]);

  if (seedTokens.length === 0) {
    console.log("[wallet-discovery] no recent safe seed tokens available");
    return [];
  }

  const evidence = new Map<
    string,
    { tokens: Set<string>; transactionCount: number; seedScoreTotal: number; maxSeedScore: number }
  >();
  let successfulSeeds = 0;
  const failures: string[] = [];

  for (const seed of seedTokens) {
    try {
      const transactions = await fetchEnhancedTransactions(seed.token_mint, apiKey);
      successfulSeeds += 1;
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
      failures.push(
        `${seed.token_symbol ?? seed.token_mint.slice(0, 6)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (successfulSeeds === 0) {
    throw new Error(
      `Helius wallet discovery could not inspect any seed token: ${failures.join(" | ")}`
    );
  }

  const candidates: Candidate[] = [];
  for (const [address, row] of evidence) {
    const tokenCount = row.tokens.size;
    const hasRepeatedEvidence = tokenCount >= 2;
    const hasStrongSingleTokenEvidence =
      tokenCount === 1 && row.transactionCount >= 2 && row.maxSeedScore >= 12;

    if (!hasRepeatedEvidence && !hasStrongSingleTokenEvidence) continue;

    candidates.push({
      address,
      tokenCount,
      transactionCount: row.transactionCount,
      seedScoreTotal: row.seedScoreTotal,
      maxSeedScore: row.maxSeedScore,
      score: tokenCount * 100 + row.seedScoreTotal * 3 + Math.min(25, row.transactionCount),
      seedTokens: [...row.tokens],
    });
  }

  console.log(
    `[wallet-discovery] Helius inspected ${successfulSeeds}/${seedTokens.length} seed tokens; ` +
      `${candidates.length} candidates passed repeated-evidence rules`
  );

  return candidates.sort((a, b) => b.score - a.score);
}

export async function discoverTrialWallets(): Promise<{
  fetched: number;
  eligible: number;
  added: string[];
}> {
  const candidates = await fetchCandidates();

  const [
    { data: existingRows, error: existingError },
    { count: activeTrialCount, error: countError },
  ] = await Promise.all([
    supabase.from("wallets").select("address, active, management_status"),
    supabase
      .from("wallets")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .eq("management_status", "trial"),
  ]);

  if (existingError) throw new Error(`Failed to load existing wallets: ${existingError.message}`);
  if (countError) throw new Error(`Failed to count trial wallets: ${countError.message}`);

  // Include disabled wallets in this set so a previously rejected wallet is never rediscovered.
  const existing = new Set((existingRows ?? []).map((row) => row.address));
  const availableSlots = Math.max(0, MAX_ACTIVE_TRIALS - (activeTrialCount ?? 0));
  const selected = candidates
    .filter((candidate) => !existing.has(candidate.address))
    .slice(0, Math.min(MAX_NEW_PER_RUN, availableSlots));

  if (selected.length === 0) {
    console.log(
      `[wallet-discovery] ${candidates.length} eligible; no safe new trial slots/candidates available`
    );
    return { fetched: candidates.length, eligible: candidates.length, added: [] };
  }

  const discoveredAt = new Date().toISOString();
  const rows = selected.map((candidate, index) => ({
    address: candidate.address,
    label: `Helius Trial ${discoveredAt.slice(0, 10)} #${index + 1}`,
    active: true,
    management_status: "trial",
    discovery_source: "helius_seed_token_cotrader",
    discovered_at: discoveredAt,
    discovery_metrics: {
      seed_token_count: candidate.tokenCount,
      observed_swap_count: candidate.transactionCount,
      seed_score_total: candidate.seedScoreTotal,
      max_seed_score: candidate.maxSeedScore,
      discovery_score: Number(candidate.score.toFixed(2)),
      seed_tokens: candidate.seedTokens,
    },
  }));

  const { data, error } = await supabase
    .from("wallets")
    .insert(rows)
    .select("address");

  if (error) throw new Error(`Failed to insert trial wallets: ${error.message}`);

  const added = (data ?? []).map((row) => row.address);
  console.log(
    `[wallet-discovery] added ${added.length} Helius trial wallet(s): ` +
      added.map((address) => `${address.slice(0, 6)}…`).join(", ")
  );

  return { fetched: candidates.length, eligible: candidates.length, added };
}

let running = false;

export function startWalletDiscoveryScheduler(): void {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await discoverTrialWallets();
    } catch (error) {
      // Fail closed: external/API/database failures must never add unverified addresses.
      console.error("[wallet-discovery] skipped safely:", error);
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(() => void run(), DISCOVERY_INTERVAL_HOURS * 3_600_000);

  console.log(
    `[wallet-discovery] Helius discovery enabled every ${DISCOVERY_INTERVAL_HOURS}h; ` +
      `max ${MAX_NEW_PER_RUN} new wallets/run; trial cap ${MAX_ACTIVE_TRIALS}`
  );
}
