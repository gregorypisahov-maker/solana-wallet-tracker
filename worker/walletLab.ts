import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchProvenTraderProfile, ProvenTraderProfile } from "./provenTraderProfile";
import {
  getDiscoveryHeliusStats,
  heliusFetchJson,
  resetDiscoveryHeliusStats,
} from "./discoveryHeliusClient";

const supabase = getSupabaseAdmin();

const INTERVAL_HOURS = bounded(process.env.WALLET_LAB_INTERVAL_HOURS, 6, 1, 24);
const OBSERVATION_HOURS = bounded(process.env.WALLET_LAB_OBSERVATION_HOURS, 72, 48, 120);
const MIN_OBSERVATIONS = Math.floor(
  bounded(process.env.WALLET_LAB_MIN_OBSERVATIONS, 8, 4, 30)
);
const PAGE_COUNT = Math.floor(bounded(process.env.WALLET_LAB_PAGES, 20, 1, 50));
const PAGE_SIZE = Math.floor(bounded(process.env.WALLET_LAB_PAGE_SIZE, 100, 25, 200));
const SEED_TOKEN_LIMIT = Math.floor(
  bounded(process.env.WALLET_LAB_SEED_TOKENS, 10, 4, 15)
);
const SEED_TRANSACTIONS = Math.floor(
  bounded(process.env.WALLET_LAB_SEED_TRANSACTIONS, 100, 25, 100)
);
const MAX_CANDIDATES_STORED = Math.floor(
  bounded(process.env.WALLET_LAB_MAX_CANDIDATES, 2_000, 250, 5_000)
);
const MAX_PROFILE_PER_RUN = Math.floor(
  bounded(process.env.WALLET_LAB_PROFILE_PER_RUN, 3, 1, 6)
);
const REQUEST_TIMEOUT_MS = Math.floor(
  bounded(process.env.WALLET_LAB_TIMEOUT_MS, 15_000, 3_000, 60_000)
);

interface CandidateSnapshot {
  address: string;
  source: string;
  score: number;
  metrics: Record<string, unknown>;
}

interface CandidateRow {
  wallet_address: string;
  status: string;
  first_seen_at: string;
  observation_count: number | string;
  leaderboard_score: number | string;
}

interface SeedToken {
  token_mint: string;
  token_symbol: string | null;
  score: number | string;
}

interface EnhancedTransaction {
  feePayer?: string;
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isWalletAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function firstNumber(rows: Record<string, unknown>[], keys: string[]): number {
  for (const row of rows) {
    for (const key of keys) {
      const value = finite(row[key], Number.NaN);
      if (Number.isFinite(value)) return value;
    }
  }
  return 0;
}

function firstAddress(row: Record<string, unknown>): string | null {
  const keys = ["wallet_address", "walletAddress", "address", "wallet", "owner", "account"];
  for (const key of keys) {
    const value = row[key];
    if (isWalletAddress(value)) return value;
  }
  return null;
}

function collectWalletRows(value: unknown, output: Record<string, unknown>[], depth = 0): void {
  if (depth > 7 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectWalletRows(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (firstAddress(row)) output.push(row);
  for (const nested of Object.values(row)) {
    if (nested && typeof nested === "object") collectWalletRows(nested, output, depth + 1);
  }
}

function normalizeLeaderboardSnapshot(
  row: Record<string, unknown>,
  source: string
): CandidateSnapshot | null {
  const address = firstAddress(row);
  if (!address) return null;
  const period = object(row.period);
  const days = object(period.days);
  const counts = object(row.counts);
  const pnl = object(row.pnl);
  const ending = object(row.ending);
  const endingPnl = object(ending.pnl);
  const value = object(row.value);
  const nested = [row, period, days, counts, pnl, endingPnl, value];

  const realizedPnl = firstNumber(nested, [
    "realized_profit_7d",
    "realized_pnl_7d",
    "realized_profit",
    "realizedPnl",
    "realized",
    "pnl",
    "profit",
  ]);
  let winRate = firstNumber(nested, [
    "winrate",
    "win_rate",
    "winRate",
    "win_percentage",
    "profit_rate",
  ]);
  if (winRate > 1) winRate /= 100;
  winRate = Math.max(0, Math.min(1, winRate));
  const trades = firstNumber(nested, [
    "trade_count",
    "trades",
    "total_trade",
    "tx_count",
    "transactions",
    "buy_count",
    "swap_count",
  ]);
  const volume = firstNumber(nested, [
    "volume_7d",
    "volume",
    "buy_volume",
    "total_volume",
    "invested",
  ]);
  const totalValue = firstNumber(nested, ["total_value", "totalValue", "net_worth", "netWorth"]);
  const leaderboardRank = firstNumber(nested, ["rank", "ranking", "index"]);

  const score = Math.max(
    0,
    Math.sign(realizedPnl) * Math.log1p(Math.abs(realizedPnl)) * 100 +
      winRate * 120 +
      Math.log1p(Math.max(0, trades)) * 24 +
      Math.log1p(Math.max(0, volume)) * 2 +
      Math.log1p(Math.max(0, totalValue)) * 3 -
      Math.max(0, leaderboardRank - 1) * 0.1
  );

  return {
    address,
    source,
    score: Number(score.toFixed(4)),
    metrics: {
      realized_pnl: realizedPnl,
      win_rate: winRate,
      trades,
      volume,
      total_value: totalValue,
      leaderboard_rank: leaderboardRank || null,
      provider: source,
      raw: row,
    },
  };
}

async function fetchPublicJson(
  url: string,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const delays = [0, 1_500, 4_000];
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await sleep(delays[attempt]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "WalletDiscoveryLab/2.0",
          ...headers,
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === delays.length - 1 || !/HTTP (429|5\d\d)|AbortError/.test(message)) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function collectConfiguredProviderCandidates(): Promise<{
  candidates: CandidateSnapshot[];
  rowsFetched: number;
  providerCalls: number;
  providers: string[];
}> {
  const byAddress = new Map<string, CandidateSnapshot>();
  let rowsFetched = 0;
  let providerCalls = 0;
  const providers: string[] = [];

  const ingest = (payload: unknown, source: string) => {
    const rows: Record<string, unknown>[] = [];
    collectWalletRows(payload, rows);
    rowsFetched += rows.length;
    for (const row of rows) {
      const candidate = normalizeLeaderboardSnapshot(row, source);
      if (!candidate) continue;
      const existing = byAddress.get(candidate.address);
      if (!existing || candidate.score > existing.score) byAddress.set(candidate.address, candidate);
    }
  };

  const solanaTrackerKey = process.env.SOLANA_TRACKER_API_KEY?.trim();
  if (solanaTrackerKey) {
    try {
      const payload = await fetchPublicJson(
        "https://data.solanatracker.io/v2/pnl/leaderboard/top?period=7&limit=100",
        { "x-api-key": solanaTrackerKey }
      );
      providerCalls += 1;
      providers.push("solana_tracker_top_traders");
      ingest(payload, "solana_tracker_top_traders");
    } catch (error) {
      console.warn("[wallet-lab] Solana Tracker source unavailable:", error);
    }
  }

  const birdeyeKey = process.env.BIRDEYE_API_KEY?.trim();
  if (birdeyeKey) {
    try {
      for (let page = 0; page < PAGE_COUNT; page += 1) {
        const offset = page * PAGE_SIZE;
        const url =
          "https://public-api.birdeye.so/wallet/v2/leaderboard" +
          `?from_value=100000&limit=${PAGE_SIZE}&offset=${offset}`;
        const payload = await fetchPublicJson(url, {
          "X-API-KEY": birdeyeKey,
          "x-chain": "solana",
        });
        providerCalls += 1;
        ingest(payload, "birdeye_wallet_leaderboard");
        if (page + 1 < PAGE_COUNT) await sleep(250);
      }
      providers.push("birdeye_wallet_leaderboard");
    } catch (error) {
      console.warn("[wallet-lab] Birdeye source unavailable:", error);
    }
  }

  const customEndpoint = process.env.WALLET_LAB_ENDPOINT?.trim();
  if (customEndpoint) {
    try {
      for (let page = 1; page <= PAGE_COUNT; page += 1) {
        const url = new URL(customEndpoint);
        url.searchParams.set("page", String(page));
        url.searchParams.set("limit", String(PAGE_SIZE));
        const payload = await fetchPublicJson(url.toString());
        providerCalls += 1;
        ingest(payload, "configured_wallet_leaderboard");
        if (page < PAGE_COUNT) await sleep(350);
      }
      providers.push("configured_wallet_leaderboard");
    } catch (error) {
      console.warn("[wallet-lab] configured public source unavailable:", error);
    }
  }

  return {
    candidates: [...byAddress.values()],
    rowsFetched,
    providerCalls,
    providers,
  };
}

function heliusApiKey(): string {
  const direct = process.env.HELIUS_API_KEY?.trim();
  if (direct) return direct;
  const rpcUrl = process.env.HELIUS_RPC_URL?.trim();
  if (rpcUrl) {
    try {
      const key = new URL(rpcUrl).searchParams.get("api-key");
      if (key) return key;
    } catch {
      // Safe configuration error below.
    }
  }
  throw new Error("HELIUS_API_KEY or HELIUS_RPC_URL is required for Wallet Lab");
}

async function loadSeedTokens(): Promise<SeedToken[]> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("token_scores")
    .select("token_mint,token_symbol,score")
    .gte("score", 8)
    .eq("dump_flag", false)
    .gte("liquidity_usd", 10_000)
    .gte("updated_at", cutoff)
    .order("score", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(SEED_TOKEN_LIMIT);
  if (error) throw new Error(`Wallet Lab seed-token load failed: ${error.message}`);
  return ((data ?? []) as SeedToken[]).filter((row) => isWalletAddress(row.token_mint));
}

async function collectHeliusSeedCandidates(): Promise<{
  candidates: CandidateSnapshot[];
  rowsFetched: number;
  heliusCalls: number;
}> {
  resetDiscoveryHeliusStats();
  const [seedTokens, apiKey, coreWalletRows] = await Promise.all([
    loadSeedTokens(),
    Promise.resolve(heliusApiKey()),
    supabase.from("wallets").select("address"),
  ]);
  if (coreWalletRows.error) {
    throw new Error(`Wallet Lab core-wallet exclusion load failed: ${coreWalletRows.error.message}`);
  }
  const excluded = new Set((coreWalletRows.data ?? []).map((row) => row.address));
  const evidence = new Map<
    string,
    {
      tokens: Set<string>;
      transactionCount: number;
      seedScoreTotal: number;
      maxSeedScore: number;
      symbols: Set<string>;
    }
  >();
  let rowsFetched = 0;

  for (const seed of seedTokens) {
    try {
      const url =
        `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(seed.token_mint)}/transactions` +
        `?api-key=${encodeURIComponent(apiKey)}&type=SWAP&limit=${SEED_TRANSACTIONS}`;
      const payload = await heliusFetchJson(url, REQUEST_TIMEOUT_MS);
      if (!Array.isArray(payload)) continue;
      rowsFetched += payload.length;
      const seenForSeed = new Set<string>();
      const seedScore = finite(seed.score);
      for (const transaction of payload as EnhancedTransaction[]) {
        const address = transaction.feePayer?.trim();
        if (!address || !isWalletAddress(address) || excluded.has(address)) continue;
        const current = evidence.get(address) ?? {
          tokens: new Set<string>(),
          transactionCount: 0,
          seedScoreTotal: 0,
          maxSeedScore: 0,
          symbols: new Set<string>(),
        };
        current.transactionCount += 1;
        current.maxSeedScore = Math.max(current.maxSeedScore, seedScore);
        if (!seenForSeed.has(address)) {
          current.tokens.add(seed.token_mint);
          if (seed.token_symbol) current.symbols.add(seed.token_symbol);
          current.seedScoreTotal += seedScore;
          seenForSeed.add(address);
        }
        evidence.set(address, current);
      }
    } catch (error) {
      console.warn(`[wallet-lab] seed ${seed.token_mint.slice(0, 6)}… skipped:`, error);
    }
  }

  const candidates = [...evidence.entries()].map(([address, row]) => {
    const score =
      row.tokens.size * 100 + row.seedScoreTotal * 3 + row.transactionCount + row.maxSeedScore * 2;
    return {
      address,
      source: "helius_seed_token_cotrader",
      score: Number(score.toFixed(4)),
      metrics: {
        provider: "helius_seed_token_cotrader",
        seed_token_count: row.tokens.size,
        transaction_count: row.transactionCount,
        seed_score_total: row.seedScoreTotal,
        max_seed_score: row.maxSeedScore,
        seed_tokens: [...row.tokens],
        seed_symbols: [...row.symbols],
      },
    } satisfies CandidateSnapshot;
  });

  return {
    candidates,
    rowsFetched,
    heliusCalls: getDiscoveryHeliusStats().heliusCallsMade,
  };
}

async function collectCandidates(): Promise<{
  fetched: number;
  candidates: CandidateSnapshot[];
  providerCalls: number;
  heliusCalls: number;
  providers: string[];
}> {
  const byAddress = new Map<string, CandidateSnapshot>();
  const provider = await collectConfiguredProviderCandidates();
  for (const candidate of provider.candidates) byAddress.set(candidate.address, candidate);

  const seed = await collectHeliusSeedCandidates();
  for (const candidate of seed.candidates) {
    const existing = byAddress.get(candidate.address);
    if (!existing || candidate.score > existing.score) byAddress.set(candidate.address, candidate);
  }

  const candidates = [...byAddress.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_STORED);
  const providers = [...provider.providers, "helius_seed_token_cotrader"];
  return {
    fetched: provider.rowsFetched + seed.rowsFetched,
    candidates,
    providerCalls: provider.providerCalls,
    heliusCalls: seed.heliusCalls,
    providers,
  };
}

async function loadExisting(addresses: string[]): Promise<Map<string, CandidateRow>> {
  const map = new Map<string, CandidateRow>();
  for (let offset = 0; offset < addresses.length; offset += 200) {
    const batch = addresses.slice(offset, offset + 200);
    const { data, error } = await supabase
      .from("wallet_lab_candidates")
      .select("wallet_address,status,first_seen_at,observation_count,leaderboard_score")
      .in("wallet_address", batch);
    if (error) throw new Error(`Wallet Lab existing-candidate load failed: ${error.message}`);
    for (const row of data ?? []) map.set(row.wallet_address, row as CandidateRow);
  }
  return map;
}

async function storeObservations(candidates: CandidateSnapshot[]): Promise<number> {
  if (candidates.length === 0) return 0;
  const now = new Date().toISOString();
  const existing = await loadExisting(candidates.map((candidate) => candidate.address));
  const candidateRows = candidates.map((candidate) => {
    const prior = existing.get(candidate.address);
    const protectedStatus = ["qualified", "rejected", "trial", "disabled"].includes(
      prior?.status ?? ""
    );
    return {
      wallet_address: candidate.address,
      source: candidate.source,
      status: protectedStatus ? prior!.status : "observing",
      first_seen_at: prior?.first_seen_at ?? now,
      last_seen_at: now,
      observation_count: finite(prior?.observation_count) + 1,
      leaderboard_score: Math.max(candidate.score, finite(prior?.leaderboard_score)),
      leaderboard_metrics: candidate.metrics,
      updated_at: now,
    };
  });
  const observationRows = candidates.map((candidate) => ({
    wallet_address: candidate.address,
    captured_at: now,
    leaderboard_score: candidate.score,
    metrics: { ...candidate.metrics, source: candidate.source },
  }));

  for (let offset = 0; offset < candidateRows.length; offset += 300) {
    const { error } = await supabase
      .from("wallet_lab_candidates")
      .upsert(candidateRows.slice(offset, offset + 300), { onConflict: "wallet_address" });
    if (error) throw new Error(`Wallet Lab candidate upsert failed: ${error.message}`);
  }
  for (let offset = 0; offset < observationRows.length; offset += 500) {
    const { error } = await supabase
      .from("wallet_lab_observations")
      .insert(observationRows.slice(offset, offset + 500));
    if (error) throw new Error(`Wallet Lab observation insert failed: ${error.message}`);
  }
  return candidates.length;
}

function labProfileReasons(profile: ProvenTraderProfile): string[] {
  const reasons: string[] = [];
  if (profile.closedTrades < 20) reasons.push(`closed_trades:${profile.closedTrades}<20`);
  if (profile.distinctClosedTokens < 5) {
    reasons.push(`distinct_closed_tokens:${profile.distinctClosedTokens}<5`);
  }
  if (profile.profitFactor == null || profile.profitFactor < 1.3) {
    reasons.push(`profit_factor:${profile.profitFactor ?? "missing"}<1.3`);
  }
  if (profile.realizedPnlSol < 0.15) {
    reasons.push(`realized_pnl:${profile.realizedPnlSol.toFixed(4)}<0.15`);
  }
  if (profile.winRate < 0.45 && (profile.profitFactor ?? 0) < 2) {
    reasons.push(`win_rate_or_asymmetry:${profile.winRate.toFixed(4)}`);
  }
  if (profile.maxDrawdownToGrossProfit > 0.75) {
    reasons.push(`drawdown_to_gross_profit:${profile.maxDrawdownToGrossProfit.toFixed(4)}>0.75`);
  }
  return reasons;
}

function trustScore(profile: ProvenTraderProfile): number {
  const pf = profile.profitFactor ?? 0;
  const score =
    55 +
    Math.min(10, Math.max(0, pf - 1.3) * 8) +
    Math.min(8, Math.max(0, profile.winRate - 0.45) * 25) +
    Math.min(5, Math.max(0, profile.closedTrades - 20) / 10) -
    Math.min(8, Math.max(0, profile.maxDrawdownToGrossProfit) * 8);
  return Number(Math.max(55, Math.min(80, score)).toFixed(2));
}

async function profileMatureCandidates(): Promise<{
  profiled: number;
  qualified: number;
  rejected: number;
  heliusCalls: number;
}> {
  const cutoff = new Date(Date.now() - OBSERVATION_HOURS * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("wallet_lab_candidates")
    .select("wallet_address,leaderboard_score")
    .in("status", ["observing", "profile_pending"])
    .lte("first_seen_at", cutoff)
    .gte("observation_count", MIN_OBSERVATIONS)
    .order("leaderboard_score", { ascending: false })
    .limit(MAX_PROFILE_PER_RUN);
  if (error) throw new Error(`Wallet Lab mature-candidate load failed: ${error.message}`);
  if (!data?.length) return { profiled: 0, qualified: 0, rejected: 0, heliusCalls: 0 };

  const apiKey = heliusApiKey();
  let qualified = 0;
  let rejected = 0;
  let heliusCalls = 0;

  for (const candidate of data) {
    const now = new Date().toISOString();
    await supabase
      .from("wallet_lab_candidates")
      .update({ status: "profile_pending", updated_at: now })
      .eq("wallet_address", candidate.wallet_address);
    try {
      const profile = await fetchProvenTraderProfile({
        wallet: candidate.wallet_address,
        apiKey,
        limit: 100,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      heliusCalls += 1;
      const reasons = labProfileReasons(profile);
      const eligible = reasons.length === 0;
      const { error: updateError } = await supabase
        .from("wallet_lab_candidates")
        .update({
          status: eligible ? "qualified" : "rejected",
          final_profile: profile,
          lab_trust_score: eligible ? trustScore(profile) : null,
          profiled_at: now,
          qualified_at: eligible ? now : null,
          rejected_at: eligible ? null : now,
          rejection_reasons: reasons,
          updated_at: now,
        })
        .eq("wallet_address", candidate.wallet_address);
      if (updateError) throw new Error(updateError.message);
      if (eligible) qualified += 1;
      else rejected += 1;
    } catch (profileError) {
      const message = profileError instanceof Error ? profileError.message : String(profileError);
      await supabase
        .from("wallet_lab_candidates")
        .update({
          status: "observing",
          rejection_reasons: [`profile_retry:${message}`],
          updated_at: new Date().toISOString(),
        })
        .eq("wallet_address", candidate.wallet_address);
      console.warn(`[wallet-lab] finalist ${candidate.wallet_address.slice(0, 6)} failed: ${message}`);
    }
    await sleep(1_100);
  }

  return { profiled: data.length, qualified, rejected, heliusCalls };
}

let running = false;
let started = false;

export async function runWalletLab(): Promise<void> {
  if (running) return;
  running = true;
  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await supabase
    .from("wallet_lab_runs")
    .insert({ status: "running", started_at: startedAt })
    .select("id")
    .single();
  if (runError) {
    running = false;
    throw new Error(`Wallet Lab run start failed: ${runError.message}`);
  }

  try {
    const collected = await collectCandidates();
    const observed = await storeObservations(collected.candidates);
    const profiled = await profileMatureCandidates();
    const totalHeliusCalls = collected.heliusCalls + profiled.heliusCalls;
    const finishedAt = new Date().toISOString();
    await supabase
      .from("wallet_lab_runs")
      .update({
        status: "success",
        fetched_count: collected.fetched,
        unique_count: collected.candidates.length,
        observed_count: observed,
        profiled_count: profiled.profiled,
        qualified_count: profiled.qualified,
        rejected_count: profiled.rejected,
        helius_calls: totalHeliusCalls,
        notes: {
          observation_hours: OBSERVATION_HOURS,
          minimum_observations: MIN_OBSERVATIONS,
          seed_tokens_per_run: SEED_TOKEN_LIMIT,
          seed_transactions_per_token: SEED_TRANSACTIONS,
          public_provider_calls: collected.providerCalls,
          providers: collected.providers,
          candidate_storage_cap: MAX_CANDIDATES_STORED,
          mature_profiles_per_run: MAX_PROFILE_PER_RUN,
          automatic_promotion: false,
        },
        finished_at: finishedAt,
      })
      .eq("id", run.id);
    console.log(
      `[wallet-lab] observed ${collected.candidates.length} unique wallets from ` +
        `${collected.providers.join(", ")}; profiled ${profiled.profiled}; ` +
        `qualified ${profiled.qualified}; Helius calls ${totalHeliusCalls}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("wallet_lab_runs")
      .update({ status: "error", error_message: message, finished_at: new Date().toISOString() })
      .eq("id", run.id);
    console.error(`[wallet-lab] run failed safely: ${message}`);
  } finally {
    running = false;
  }
}

export function startWalletLabScheduler(): void {
  if (started) return;
  started = true;
  void runWalletLab();
  setInterval(() => void runWalletLab(), INTERVAL_HOURS * 3_600_000);
  console.log(
    `[wallet-lab] enabled every ${INTERVAL_HOURS}h; observes candidates for ${OBSERVATION_HOURS}h; ` +
      `capped at ${SEED_TOKEN_LIMIT} Helius seed calls plus ${MAX_PROFILE_PER_RUN} mature profiles/run`
  );
}
