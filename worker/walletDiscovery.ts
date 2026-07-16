import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();

const GMGN_ENDPOINT =
  process.env.GMGN_WALLET_DISCOVERY_URL ??
  "https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?orderby=realized_profit_7d&direction=desc";

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
const MIN_PNL_7D_USD = boundedNumber(
  process.env.WALLET_DISCOVERY_MIN_PNL_7D_USD,
  1_000,
  0,
  1_000_000
);
const MAX_PNL_7D_USD = boundedNumber(
  process.env.WALLET_DISCOVERY_MAX_PNL_7D_USD,
  2_000_000,
  10_000,
  100_000_000
);
const MIN_WIN_RATE = boundedNumber(
  process.env.WALLET_DISCOVERY_MIN_WIN_RATE,
  0.5,
  0,
  1
);
const MIN_TRADES_7D = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_MIN_TRADES_7D, 10, 1, 10_000)
);
const MAX_TRADES_7D = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_MAX_TRADES_7D, 1_000, 10, 100_000)
);
const REQUEST_TIMEOUT_MS = Math.floor(
  boundedNumber(process.env.WALLET_DISCOVERY_TIMEOUT_MS, 15_000, 3_000, 60_000)
);

interface Candidate {
  address: string;
  pnl7d: number;
  winRate: number;
  trades7d: number;
  score: number;
  raw: Record<string, unknown>;
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

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function normalizeRate(value: number | null): number {
  if (value === null) return 0;
  return value > 1 ? value / 100 : value;
}

function isSolanaAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function collectObjects(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const address = firstString(record, [
    "wallet_address",
    "wallet",
    "address",
    "owner",
    "maker",
  ]);
  if (address && isSolanaAddress(address)) output.push(record);

  for (const nested of Object.values(record)) collectObjects(nested, output);
}

function toCandidate(record: Record<string, unknown>): Candidate | null {
  const address = firstString(record, [
    "wallet_address",
    "wallet",
    "address",
    "owner",
    "maker",
  ]);
  if (!address || !isSolanaAddress(address)) return null;

  const pnl7d =
    firstNumber(record, [
      "realized_profit_7d",
      "pnl_7d",
      "profit_7d",
      "realized_pnl_7d",
    ]) ?? 0;
  const winRate = normalizeRate(
    firstNumber(record, ["winrate_7d", "win_rate_7d", "winrate", "win_rate"])
  );
  const trades7d = Math.round(
    firstNumber(record, [
      "txs_7d",
      "trades_7d",
      "trade_count_7d",
      "buy_7d",
      "token_num_7d",
    ]) ?? 0
  );

  if (pnl7d < MIN_PNL_7D_USD || pnl7d > MAX_PNL_7D_USD) return null;
  if (winRate < MIN_WIN_RATE || winRate > 0.95) return null;
  if (trades7d < MIN_TRADES_7D || trades7d > MAX_TRADES_7D) return null;

  // Prefer repeatable performance, not a single giant outlier or hyperactive bot.
  const pnlScore = Math.min(50, Math.log10(Math.max(10, pnl7d)) * 10);
  const winScore = winRate * 35;
  const activityScore = Math.min(15, Math.log10(Math.max(10, trades7d)) * 7.5);

  return {
    address,
    pnl7d,
    winRate,
    trades7d,
    score: pnlScore + winScore + activityScore,
    raw: record,
  };
}

async function fetchCandidates(): Promise<Candidate[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GMGN_ENDPOINT, {
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent":
          "Mozilla/5.0 (compatible; SolanaWalletTracker/1.0; trial-wallet-discovery)",
      },
    });

    if (!response.ok) {
      throw new Error(`GMGN leaderboard returned HTTP ${response.status}`);
    }

    const payload: unknown = await response.json();
    const objects: Record<string, unknown>[] = [];
    collectObjects(payload, objects);

    const byAddress = new Map<string, Candidate>();
    for (const record of objects) {
      const candidate = toCandidate(record);
      if (!candidate) continue;
      const previous = byAddress.get(candidate.address);
      if (!previous || candidate.score > previous.score) {
        byAddress.set(candidate.address, candidate);
      }
    }

    return [...byAddress.values()].sort((a, b) => b.score - a.score);
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverTrialWallets(): Promise<{
  fetched: number;
  eligible: number;
  added: string[];
}> {
  const candidates = await fetchCandidates();

  const [{ data: existingRows, error: existingError }, { count: activeTrialCount, error: countError }] =
    await Promise.all([
      supabase.from("wallets").select("address, active, management_status"),
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
  const selected = candidates
    .filter((candidate) => !existing.has(candidate.address))
    .slice(0, Math.min(MAX_NEW_PER_RUN, availableSlots));

  if (selected.length === 0) {
    console.log(
      `[wallet-discovery] ${candidates.length} eligible; no safe new trial slots available`
    );
    return { fetched: candidates.length, eligible: candidates.length, added: [] };
  }

  const discoveredAt = new Date().toISOString();
  const rows = selected.map((candidate, index) => ({
    address: candidate.address,
    label: `GMGN Trial ${discoveredAt.slice(0, 10)} #${index + 1}`,
    active: true,
    management_status: "trial",
    discovery_source: "gmgn_smart_money_7d",
    discovered_at: discoveredAt,
    discovery_metrics: {
      pnl_7d_usd: candidate.pnl7d,
      win_rate_7d: candidate.winRate,
      trades_7d: candidate.trades7d,
      discovery_score: Number(candidate.score.toFixed(2)),
    },
  }));

  const { data, error } = await supabase
    .from("wallets")
    .insert(rows)
    .select("address");

  if (error) throw new Error(`Failed to insert trial wallets: ${error.message}`);

  const added = (data ?? []).map((row) => row.address);
  console.log(
    `[wallet-discovery] added ${added.length} GMGN trial wallet(s): ` +
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
      // Fail closed: a changed endpoint, malformed response, or network error
      // must never add unverified addresses.
      console.error("[wallet-discovery] skipped safely:", error);
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(() => void run(), DISCOVERY_INTERVAL_HOURS * 3_600_000);

  console.log(
    `[wallet-discovery] enabled every ${DISCOVERY_INTERVAL_HOURS}h; ` +
      `max ${MAX_NEW_PER_RUN} new wallets/run; trial cap ${MAX_ACTIVE_TRIALS}`
  );
}
