import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchProvenTraderProfile, ProvenTraderProfile } from "./provenTraderProfile";

const supabase = getSupabaseAdmin();

const SOURCE = "gmgn_smart_money_7d";
const DEFAULT_ENDPOINT =
  "https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?orderby=realized_profit_7d&direction=desc";
const ENDPOINT = process.env.WALLET_LAB_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
const INTERVAL_HOURS = bounded(process.env.WALLET_LAB_INTERVAL_HOURS, 6, 1, 24);
const OBSERVATION_HOURS = bounded(process.env.WALLET_LAB_OBSERVATION_HOURS, 72, 48, 120);
const MIN_OBSERVATIONS = Math.floor(
  bounded(process.env.WALLET_LAB_MIN_OBSERVATIONS, 8, 4, 30)
);
const PAGE_COUNT = Math.floor(bounded(process.env.WALLET_LAB_PAGES, 20, 1, 50));
const PAGE_SIZE = Math.floor(bounded(process.env.WALLET_LAB_PAGE_SIZE, 100, 25, 200));
const MAX_PROFILE_PER_RUN = Math.floor(
  bounded(process.env.WALLET_LAB_PROFILE_PER_RUN, 3, 1, 6)
);
const REQUEST_TIMEOUT_MS = Math.floor(
  bounded(process.env.WALLET_LAB_TIMEOUT_MS, 15_000, 3_000, 60_000)
);

interface CandidateSnapshot {
  address: string;
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

function isWalletAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = finite(row[key], Number.NaN);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function firstAddress(row: Record<string, unknown>): string | null {
  const keys = [
    "wallet_address",
    "walletAddress",
    "address",
    "wallet",
    "owner",
    "account",
  ];
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

function normalizeSnapshot(row: Record<string, unknown>): CandidateSnapshot | null {
  const address = firstAddress(row);
  if (!address) return null;

  const realizedPnl = firstNumber(row, [
    "realized_profit_7d",
    "realized_pnl_7d",
    "realized_profit",
    "realizedPnl",
    "pnl",
    "profit",
  ]);
  let winRate = firstNumber(row, ["winrate", "win_rate", "winRate", "profit_rate"]);
  if (winRate > 1) winRate /= 100;
  winRate = Math.max(0, Math.min(1, winRate));
  const trades = firstNumber(row, [
    "trade_count",
    "trades",
    "tx_count",
    "transactions",
    "buy_count",
    "swap_count",
  ]);
  const volume = firstNumber(row, ["volume_7d", "volume", "buy_volume", "total_volume"]);
  const leaderboardRank = firstNumber(row, ["rank", "ranking", "index"]);

  const score = Math.max(
    0,
    realizedPnl * 100 + winRate * 120 + Math.log1p(Math.max(0, trades)) * 24 +
      Math.log1p(Math.max(0, volume)) * 2 - Math.max(0, leaderboardRank - 1) * 0.1
  );

  return {
    address,
    score: Number(score.toFixed(4)),
    metrics: {
      realized_pnl_7d: realizedPnl,
      win_rate: winRate,
      trades,
      volume,
      leaderboard_rank: leaderboardRank || null,
      raw: row,
    },
  };
}

function pageUrl(page: number): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(PAGE_SIZE));
  return url.toString();
}

async function fetchJson(url: string): Promise<unknown> {
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
          "user-agent": "Mozilla/5.0 WalletDiscoveryLab/1.0",
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

async function collectCandidates(): Promise<{ fetched: number; candidates: CandidateSnapshot[] }> {
  const byAddress = new Map<string, CandidateSnapshot>();
  let fetched = 0;
  let emptyGrowthPages = 0;

  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const payload = await fetchJson(pageUrl(page));
    const rows: Record<string, unknown>[] = [];
    collectWalletRows(payload, rows);
    fetched += rows.length;
    const before = byAddress.size;
    for (const row of rows) {
      const candidate = normalizeSnapshot(row);
      if (!candidate) continue;
      const existing = byAddress.get(candidate.address);
      if (!existing || candidate.score > existing.score) byAddress.set(candidate.address, candidate);
    }
    emptyGrowthPages = byAddress.size === before ? emptyGrowthPages + 1 : 0;
    if (emptyGrowthPages >= 3) break;
    if (page < PAGE_COUNT) await sleep(550);
  }

  return {
    fetched,
    candidates: [...byAddress.values()].sort((a, b) => b.score - a.score),
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
    if (error) throw new Error(`wallet lab existing-candidate load failed: ${error.message}`);
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
    const protectedStatus = ["qualified", "trial", "disabled"].includes(prior?.status ?? "");
    return {
      wallet_address: candidate.address,
      source: SOURCE,
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
    metrics: candidate.metrics,
  }));

  for (let offset = 0; offset < candidateRows.length; offset += 300) {
    const { error } = await supabase
      .from("wallet_lab_candidates")
      .upsert(candidateRows.slice(offset, offset + 300), { onConflict: "wallet_address" });
    if (error) throw new Error(`wallet lab candidate upsert failed: ${error.message}`);
  }
  for (let offset = 0; offset < observationRows.length; offset += 500) {
    const { error } = await supabase
      .from("wallet_lab_observations")
      .insert(observationRows.slice(offset, offset + 500));
    if (error) throw new Error(`wallet lab observation insert failed: ${error.message}`);
  }
  return candidates.length;
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
      // Safe error below.
    }
  }
  throw new Error("HELIUS_API_KEY or HELIUS_RPC_URL is required for finalist profiling");
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
  if (error) throw new Error(`wallet lab mature-candidate load failed: ${error.message}`);
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
    throw new Error(`wallet lab run start failed: ${runError.message}`);
  }

  try {
    const collected = await collectCandidates();
    const observed = await storeObservations(collected.candidates);
    const profiled = await profileMatureCandidates();
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
        helius_calls: profiled.heliusCalls,
        notes: {
          observation_hours: OBSERVATION_HOURS,
          minimum_observations: MIN_OBSERVATIONS,
          pages_requested: PAGE_COUNT,
          page_size: PAGE_SIZE,
          automatic_promotion: false,
        },
        finished_at: finishedAt,
      })
      .eq("id", run.id);
    console.log(
      `[wallet-lab] collected ${collected.candidates.length} unique wallets; ` +
        `profiled ${profiled.profiled}; qualified ${profiled.qualified}; ` +
        `Helius calls ${profiled.heliusCalls}`
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
    `[wallet-lab] enabled every ${INTERVAL_HOURS}h; observing up to ${PAGE_COUNT * PAGE_SIZE} ` +
      `leaderboard rows for ${OBSERVATION_HOURS}h; profiles only ${MAX_PROFILE_PER_RUN} mature finalists/run`
  );
}
