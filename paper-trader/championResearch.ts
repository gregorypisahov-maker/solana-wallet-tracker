import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const VERSION = "champion_research_v1_2026_08_05";
const HORIZONS = [60, 180, 300, 900, 1800] as const;
const GECKO_URLS = [
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=5m&page=1",
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=1",
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=2",
] as const;
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

const CONFIG = {
  scanMs: envNumber("CHAMPION_SCAN_INTERVAL_MS", 60_000, 30_000, 600_000),
  outcomeMs: envNumber("CHAMPION_OUTCOME_INTERVAL_MS", 30_000, 15_000, 300_000),
  maxPerScan: Math.floor(envNumber("CHAMPION_MAX_CANDIDATES_PER_SCAN", 30, 5, 100)),
  minLiquidityUsd: envNumber("CHAMPION_MIN_LIQUIDITY_USD", 100_000, 10_000, 100_000_000),
  minMarketCapUsd: envNumber("CHAMPION_MIN_MARKET_CAP_USD", 250_000, 10_000, 10_000_000_000),
  maxMarketCapUsd: envNumber("CHAMPION_MAX_MARKET_CAP_USD", 20_000_000, 20_000, 100_000_000_000),
  minPoolAgeMinutes: envNumber("CHAMPION_MIN_POOL_AGE_MINUTES", 360, 15, 525_600),
  targetPct: envNumber("CHAMPION_RESEARCH_TARGET_PCT", 8, 0.5, 100),
  stopPct: envNumber("CHAMPION_RESEARCH_STOP_PCT", 4, 0.5, 100),
  minScore: envNumber("CHAMPION_MIN_SCORE", 60, 0, 100),
} as const;

const BLOCKED_SYMBOLS = new Set([
  "USD", "USDC", "USDT", "SOL", "WSOL", "BTC", "WBTC", "ETH", "WETH", "BNB",
]);
const BLOCKED_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

type Candidate = {
  mint: string;
  symbol: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  poolAgeMinutes: number;
  change5mPct: number;
  change1hPct: number;
  volume5mUsd: number;
  volume1hUsd: number;
  buys5m: number;
  sells5m: number;
};

type StoredCandidate = {
  candidate_id: string;
  mint: string;
  pair_address: string | null;
  detected_at: string;
  signal_price_usd: number | string | null;
};

let scanRunning = false;
let outcomeRunning = false;

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "user-agent": "champion-research/1.0" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parsePool(row: any): Candidate | null {
  const a = row?.attributes;
  const mint = String(row?.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, "");
  if (!a || !mint || BLOCKED_MINTS.has(mint)) return null;
  const symbol = String(a.name ?? "UNKNOWN").split("/")[0]?.trim().toUpperCase() || "UNKNOWN";
  if (BLOCKED_SYMBOLS.has(symbol)) return null;
  const createdMs = Date.parse(String(a.pool_created_at ?? ""));
  const candidate: Candidate = {
    mint,
    symbol,
    pairAddress: String(a.address ?? ""),
    priceUsd: n(a.base_token_price_usd, NaN),
    liquidityUsd: n(a.reserve_in_usd, NaN),
    marketCapUsd: n(a.market_cap_usd ?? a.fdv_usd, NaN),
    poolAgeMinutes: Number.isFinite(createdMs) ? Math.max(0, Date.now() - createdMs) / 60_000 : NaN,
    change5mPct: n(a.price_change_percentage?.m5, NaN),
    change1hPct: n(a.price_change_percentage?.h1, NaN),
    volume5mUsd: n(a.volume_usd?.m5, NaN),
    volume1hUsd: n(a.volume_usd?.h1, NaN),
    buys5m: Math.max(0, Math.floor(n(a.transactions?.m5?.buys, 0))),
    sells5m: Math.max(0, Math.floor(n(a.transactions?.m5?.sells, 0))),
  };
  const valid = candidate.pairAddress && Object.values(candidate).every(
    (value) => typeof value !== "number" || Number.isFinite(value)
  );
  return valid ? candidate : null;
}

function score(c: Candidate): number {
  const liquidity = Math.min(20, c.liquidityUsd / 500_000 * 20);
  const acceleration = c.volume1hUsd > 0
    ? Math.min(20, c.volume5mUsd / Math.max(1, c.volume1hUsd / 12) * 10)
    : 0;
  const momentum5m = Math.max(0, Math.min(20, c.change5mPct * 3));
  const momentum1h = Math.max(0, Math.min(15, c.change1hPct));
  const flow = Math.min(25, c.buys5m / Math.max(1, c.sells5m) * 12.5);
  return Math.round(Math.min(100, liquidity + acceleration + momentum5m + momentum1h + flow));
}

function reasons(c: Candidate, candidateScore: number): string[] {
  const result: string[] = [];
  if (c.liquidityUsd < CONFIG.minLiquidityUsd) result.push("liquidity_below_minimum");
  if (c.marketCapUsd < CONFIG.minMarketCapUsd) result.push("market_cap_below_minimum");
  if (c.marketCapUsd > CONFIG.maxMarketCapUsd) result.push("market_cap_above_maximum");
  if (c.poolAgeMinutes < CONFIG.minPoolAgeMinutes) result.push("pool_too_new");
  if (c.change5mPct <= 0) result.push("five_minute_momentum_not_positive");
  if (c.buys5m <= c.sells5m) result.push("buy_flow_not_dominant");
  if (candidateScore < CONFIG.minScore) result.push("score_below_minimum");
  return result;
}

async function stateEnabled(): Promise<boolean> {
  const { data, error } = await supabase
    .from("champion_strategy_state")
    .select("enabled,paper_only,mode,active_version")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return Boolean(data?.enabled && data?.paper_only && data?.mode === "research" && data?.active_version === VERSION);
}

async function discover(): Promise<Candidate[]> {
  const settled = await Promise.allSettled(GECKO_URLS.map(fetchJson));
  const byMint = new Map<string, Candidate>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const row of Array.isArray(result.value?.data) ? result.value.data : []) {
      const candidate = parsePool(row);
      if (!candidate) continue;
      const previous = byMint.get(candidate.mint);
      if (!previous || candidate.liquidityUsd > previous.liquidityUsd) byMint.set(candidate.mint, candidate);
    }
  }
  return [...byMint.values()]
    .sort((left, right) => right.volume5mUsd - left.volume5mUsd)
    .slice(0, CONFIG.maxPerScan);
}

async function storeCandidate(candidate: Candidate): Promise<void> {
  const cutoff = new Date(Date.now() - CONFIG.scanMs * 0.9).toISOString();
  const { data: existing, error: existingError } = await supabase
    .from("champion_candidates")
    .select("candidate_id")
    .eq("strategy_version", VERSION)
    .eq("mint", candidate.mint)
    .gte("detected_at", cutoff)
    .limit(1);
  if (existingError) throw existingError;
  if (existing?.length) return;

  const candidateScore = score(candidate);
  const decisionReasons = reasons(candidate, candidateScore);
  const { error } = await supabase.from("champion_candidates").insert({
    candidate_id: randomUUID(),
    strategy_version: VERSION,
    experiment_arm: "champion",
    mint: candidate.mint,
    token_symbol: candidate.symbol,
    pair_address: candidate.pairAddress,
    detected_at: new Date().toISOString(),
    source: "geckoterminal_established_liquid",
    decision: decisionReasons.length ? "rejected_research" : "accepted_research",
    decision_reasons: decisionReasons,
    score: candidateScore,
    signal_price_usd: candidate.priceUsd,
    liquidity_usd: candidate.liquidityUsd,
    market_cap_usd: candidate.marketCapUsd,
    pool_age_minutes: candidate.poolAgeMinutes,
    features: candidate,
    quote_snapshot: {},
  });
  if (error) throw error;
}

async function runScan(): Promise<void> {
  if (scanRunning || !(await stateEnabled())) return;
  scanRunning = true;
  try {
    const candidates = await discover();
    for (const candidate of candidates) await storeCandidate(candidate);
    await supabase.from("champion_strategy_state").update({
      last_scan_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      config: CONFIG,
    }).eq("id", 1);
    console.log(`[champion-research] scanned=${candidates.length} version=${VERSION}`);
  } finally {
    scanRunning = false;
  }
}

async function dexPair(mint: string, pairAddress: string | null) {
  const rows = await fetchJson(`${DEX_URL}/${encodeURIComponent(mint)}`);
  const pairs = Array.isArray(rows) ? rows : [];
  return pairs.find((pair: any) => pair?.pairAddress === pairAddress) ??
    pairs.filter((pair: any) => pair?.chainId === "solana" && pair?.baseToken?.address === mint)
      .sort((a: any, b: any) => n(b?.liquidity?.usd) - n(a?.liquidity?.usd))[0] ?? null;
}

async function dueCandidates(): Promise<Array<StoredCandidate & { horizon: number }>> {
  const oldest = new Date(Date.now() - 31 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("champion_candidates")
    .select("candidate_id,mint,pair_address,detected_at,signal_price_usd")
    .eq("strategy_version", VERSION)
    .gte("detected_at", oldest)
    .order("detected_at", { ascending: true })
    .limit(250);
  if (error) throw error;

  const result: Array<StoredCandidate & { horizon: number }> = [];
  for (const candidate of (data ?? []) as StoredCandidate[]) {
    const ageSeconds = Math.floor((Date.now() - Date.parse(candidate.detected_at)) / 1000);
    for (const horizon of HORIZONS) {
      if (ageSeconds < horizon) continue;
      const { data: existing, error: existingError } = await supabase
        .from("champion_candidate_outcomes")
        .select("candidate_id")
        .eq("candidate_id", candidate.candidate_id)
        .eq("horizon_seconds", horizon)
        .limit(1);
      if (existingError) throw existingError;
      if (!existing?.length) result.push({ ...candidate, horizon });
    }
  }
  return result.slice(0, 40);
}

async function measure(item: StoredCandidate & { horizon: number }): Promise<void> {
  const entry = n(item.signal_price_usd, 0);
  if (entry <= 0) return;
  const pair = await dexPair(item.mint, item.pair_address);
  const price = n(pair?.priceUsd, 0);
  const liquidity = n(pair?.liquidity?.usd, 0);
  const grossPct = price > 0 ? (price / entry - 1) * 100 : null;

  const { data: previous, error: previousError } = await supabase
    .from("champion_candidate_outcomes")
    .select("max_favorable_excursion_pct,max_adverse_excursion_pct")
    .eq("candidate_id", item.candidate_id)
    .order("horizon_seconds", { ascending: false })
    .limit(1);
  if (previousError) throw previousError;
  const previousMfe = n(previous?.[0]?.max_favorable_excursion_pct, 0);
  const previousMae = n(previous?.[0]?.max_adverse_excursion_pct, 0);
  const mfe = grossPct == null ? previousMfe : Math.max(previousMfe, grossPct);
  const mae = grossPct == null ? previousMae : Math.min(previousMae, grossPct);

  const { error } = await supabase.from("champion_candidate_outcomes").insert({
    candidate_id: item.candidate_id,
    horizon_seconds: item.horizon,
    measured_at: new Date().toISOString(),
    market_price_usd: price || null,
    executable_exit_price_usd: null,
    gross_return_pct: grossPct,
    executable_net_return_pct: null,
    max_favorable_excursion_pct: mfe,
    max_adverse_excursion_pct: mae,
    liquidity_usd: liquidity || null,
    route_available: null,
    became_untradable: !pair || price <= 0 || liquidity <= 0,
    target_hit_before_stop: mfe >= CONFIG.targetPct && mae > -CONFIG.stopPct,
    stop_hit_before_target: mae <= -CONFIG.stopPct && mfe < CONFIG.targetPct,
    snapshot: { pair, target_pct: CONFIG.targetPct, stop_pct: CONFIG.stopPct },
  });
  if (error) throw error;
}

async function runOutcomes(): Promise<void> {
  if (outcomeRunning || !(await stateEnabled())) return;
  outcomeRunning = true;
  try {
    const due = await dueCandidates();
    for (const item of due) {
      try { await measure(item); }
      catch (error) { console.warn(`[champion-research] outcome failed ${item.mint}`, error); }
    }
    if (due.length) {
      await supabase.from("champion_strategy_state").update({
        last_outcome_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", 1);
    }
  } finally {
    outcomeRunning = false;
  }
}

export function startChampionResearchScheduler(): void {
  console.log(`[champion-research] loaded version=${VERSION} paperOnly=true trading=false`);
  void runScan().catch((error) => console.error("[champion-research] initial scan failed", error));
  void runOutcomes().catch((error) => console.error("[champion-research] initial outcomes failed", error));
  setInterval(() => void runScan().catch((error) => console.error("[champion-research] scan failed", error)), CONFIG.scanMs);
  setInterval(() => void runOutcomes().catch((error) => console.error("[champion-research] outcomes failed", error)), CONFIG.outcomeMs);
}
