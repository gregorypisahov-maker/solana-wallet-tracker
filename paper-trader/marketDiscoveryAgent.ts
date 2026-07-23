import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const VERSION = "market_discovery_ai_v1_2026_07_24";
const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_INTERVAL_MS = 60_000;
const TOP_LIMIT = 25;
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  WRAPPED_SOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

const FEEDS = [
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=5m&page=1",
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=1",
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=2",
  "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1",
] as const;

type Candidate = {
  mint: string;
  symbol: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  changeM5: number;
  changeH1: number;
  volumeM5: number;
  volumeH1: number;
  buysM5: number;
  sellsM5: number;
  buyersM5: number;
  poolAgeMinutes: number;
};

type Ranked = Candidate & {
  score: number;
  confidence: "low" | "medium" | "high";
  status: "watching" | "armed";
  reasons: string[];
  risks: string[];
};

let running = false;

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripId(value: unknown): string {
  return String(value ?? "").replace(/^solana_/, "");
}

function intervalMs(): number {
  const parsed = Number(process.env.MARKET_DISCOVERY_INTERVAL_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.min(300_000, Math.max(30_000, parsed));
}

function enabled(): boolean {
  const raw = process.env.ENABLE_MARKET_DISCOVERY_AI?.trim().toLowerCase();
  return !raw || !["0", "false", "off", "no"].includes(raw);
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.api+json;version=20230302",
        "User-Agent": "solana-market-discovery-ai/1.0",
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parse(row: any): Candidate | null {
  const a = row?.attributes;
  const mint = stripId(row?.relationships?.base_token?.data?.id);
  if (!a || !mint || STABLES.has(mint)) return null;

  const createdAt = Date.parse(String(a.pool_created_at ?? ""));
  const candidate: Candidate = {
    mint,
    symbol: String(a.name ?? "UNKNOWN").split("/")[0]?.trim() || "UNKNOWN",
    pairAddress: String(a.address ?? ""),
    priceUsd: num(a.base_token_price_usd, NaN),
    liquidityUsd: num(a.reserve_in_usd, NaN),
    marketCapUsd: num(a.market_cap_usd ?? a.fdv_usd, NaN),
    changeM5: num(a.price_change_percentage?.m5, NaN),
    changeH1: num(a.price_change_percentage?.h1, NaN),
    volumeM5: num(a.volume_usd?.m5, NaN),
    volumeH1: num(a.volume_usd?.h1, NaN),
    buysM5: Math.max(0, Math.floor(num(a.transactions?.m5?.buys, NaN))),
    sellsM5: Math.max(0, Math.floor(num(a.transactions?.m5?.sells, NaN))),
    buyersM5: Math.max(0, Math.floor(num(a.transactions?.m5?.buyers, NaN))),
    poolAgeMinutes: Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) / 60_000 : NaN,
  };

  const values = Object.values(candidate).filter((value) => typeof value === "number") as number[];
  if (!candidate.pairAddress || values.some((value) => !Number.isFinite(value))) return null;
  if (candidate.priceUsd <= 0 || candidate.liquidityUsd <= 0 || candidate.marketCapUsd <= 0) return null;
  return candidate;
}

async function discover(): Promise<Candidate[]> {
  const results = await Promise.allSettled(FEEDS.map(fetchJson));
  const byMint = new Map<string, Candidate>();
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[market-discovery-ai] feed failed:", result.reason);
      continue;
    }
    const rows = Array.isArray(result.value?.data) ? result.value.data : [];
    for (const row of rows) {
      const candidate = parse(row);
      if (!candidate) continue;
      const existing = byMint.get(candidate.mint);
      if (!existing || candidate.liquidityUsd > existing.liquidityUsd) byMint.set(candidate.mint, candidate);
    }
  }
  if (byMint.size === 0 && results.every((result) => result.status === "rejected")) {
    throw new Error("all discovery feeds failed");
  }
  return [...byMint.values()];
}

function rank(c: Candidate): Ranked {
  let score = 0;
  const reasons: string[] = [];
  const risks: string[] = [];
  const buyRatio = c.buysM5 / Math.max(1, c.buysM5 + c.sellsM5);
  const turnover = c.volumeM5 / Math.max(1, c.liquidityUsd);
  const liqToCap = c.liquidityUsd / Math.max(1, c.marketCapUsd);

  if (c.liquidityUsd >= 150_000) { score += 22; reasons.push("deep_liquidity"); }
  else if (c.liquidityUsd >= 60_000) { score += 17; reasons.push("healthy_liquidity"); }
  else if (c.liquidityUsd >= 25_000) { score += 10; reasons.push("acceptable_liquidity"); }
  else risks.push("thin_liquidity");

  if (c.volumeM5 >= 75_000) { score += 18; reasons.push("strong_volume_acceleration"); }
  else if (c.volumeM5 >= 25_000) { score += 12; reasons.push("rising_short_term_volume"); }
  else if (c.volumeM5 >= 8_000) score += 6;

  if (buyRatio >= 0.68 && c.buysM5 >= 20) { score += 16; reasons.push("strong_buy_pressure"); }
  else if (buyRatio >= 0.58 && c.buysM5 >= 10) { score += 10; reasons.push("positive_buy_pressure"); }
  else if (buyRatio < 0.45) risks.push("sell_pressure");

  if (c.buyersM5 >= 35) { score += 14; reasons.push("broad_buyer_growth"); }
  else if (c.buyersM5 >= 15) { score += 8; reasons.push("buyer_count_rising"); }

  if (c.changeM5 >= 2 && c.changeM5 <= 12) { score += 12; reasons.push("healthy_momentum"); }
  else if (c.changeM5 > 12 && c.changeM5 <= 25) { score += 5; risks.push("extended_momentum"); }
  else if (c.changeM5 > 25) { score -= 12; risks.push("vertical_price_spike"); }
  else if (c.changeM5 < -4) risks.push("negative_momentum");

  if (c.changeH1 >= 5 && c.changeH1 <= 60) { score += 8; reasons.push("one_hour_confirmation"); }
  else if (c.changeH1 > 100) { score -= 8; risks.push("late_entry_risk"); }

  if (liqToCap >= 0.15) { score += 6; reasons.push("strong_liquidity_to_cap"); }
  else if (liqToCap < 0.05) risks.push("weak_liquidity_to_cap");

  if (turnover >= 0.15 && turnover <= 2.5) score += 4;
  else if (turnover > 4) risks.push("possible_churn_or_fake_volume");

  if (c.poolAgeMinutes >= 20 && c.poolAgeMinutes <= 720) { score += 6; reasons.push("useful_pool_age"); }
  else if (c.poolAgeMinutes < 5) { score -= 10; risks.push("extremely_new_pool"); }

  if (c.marketCapUsd < 20_000) risks.push("micro_market_cap");
  if (c.marketCapUsd > 5_000_000) risks.push("outside_primary_discovery_range");

  score = Math.max(0, Math.min(100, Math.round(score)));
  const confidence = score >= 78 ? "high" : score >= 62 ? "medium" : "low";
  const status = score >= 78 && risks.length <= 2 ? "armed" : "watching";
  return { ...c, score, confidence, status, reasons, risks };
}

function regime(ranked: Ranked[]): string {
  if (ranked.length === 0) return "quiet";
  const strong = ranked.filter((item) => item.score >= 70).length;
  const positive = ranked.filter((item) => item.changeM5 > 0).length / ranked.length;
  if (strong >= 8 && positive >= 0.7) return "hot";
  if (strong >= 3 && positive >= 0.55) return "normal";
  if (positive < 0.4) return "weak";
  return "selective";
}

async function persist(startedAt: string, candidates: Candidate[], ranked: Ranked[], marketRegime: string): Promise<void> {
  const now = new Date().toISOString();
  const top = ranked.slice(0, TOP_LIMIT);
  if (top.length > 0) {
    const { error } = await supabase.from("market_opportunities").upsert(
      top.map((item) => ({
        mint: item.mint,
        token_symbol: item.symbol,
        pair_address: item.pairAddress,
        score: item.score,
        confidence: item.confidence,
        status: item.status,
        market_regime: marketRegime,
        liquidity_usd: item.liquidityUsd,
        market_cap_usd: item.marketCapUsd,
        price_usd: item.priceUsd,
        price_change_m5: item.changeM5,
        price_change_h1: item.changeH1,
        volume_m5_usd: item.volumeM5,
        volume_h1_usd: item.volumeH1,
        buys_m5: item.buysM5,
        sells_m5: item.sellsM5,
        buyers_m5: item.buyersM5,
        pool_age_minutes: item.poolAgeMinutes,
        reasons: item.reasons,
        risks: item.risks,
        signal_snapshot: { version: VERSION, buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5) },
        last_seen_at: now,
        updated_at: now,
      })),
      { onConflict: "mint" }
    );
    if (error) throw new Error(`opportunity upsert failed: ${error.message}`);
  }

  const { error } = await supabase.from("market_discovery_runs").insert({
    started_at: startedAt,
    finished_at: now,
    status: "ok",
    scanned_count: candidates.length,
    ranked_count: ranked.length,
    top_symbol: top[0]?.symbol ?? null,
    top_mint: top[0]?.mint ?? null,
    top_score: top[0]?.score ?? null,
    market_regime: marketRegime,
    message: top[0] ? `top_candidate:${top[0].symbol}` : "no_candidates",
    snapshot: { version: VERSION, top: top.slice(0, 10) },
  });
  if (error) throw new Error(`discovery run insert failed: ${error.message}`);

  await supabase.from("market_opportunities").delete().lt("last_seen_at", new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());
}

export async function runMarketDiscoveryScan(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const candidates = await discover();
    const ranked = candidates.map(rank).sort((a, b) => b.score - a.score);
    const marketRegime = regime(ranked);
    await persist(startedAt, candidates, ranked, marketRegime);
    const top = ranked[0];
    console.log(`[market-discovery-ai] scanned ${candidates.length}; regime ${marketRegime}; top ${top ? `${top.symbol} ${top.score}/100` : "none"}`);
  } catch (error) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    console.error("[market-discovery-ai] scan failed:", error);
    await supabase.from("market_discovery_runs").insert({
      started_at: startedAt,
      finished_at: now,
      status: "error",
      message,
      snapshot: { version: VERSION },
    });
  }
}

async function runSafely(): Promise<void> {
  if (running) return;
  running = true;
  try { await runMarketDiscoveryScan(); } finally { running = false; }
}

export function startMarketDiscoveryAgent(): void {
  if (!enabled()) {
    console.log("[market-discovery-ai] disabled by ENABLE_MARKET_DISCOVERY_AI");
    return;
  }
  const every = intervalMs();
  console.log(`[market-discovery-ai] ${VERSION} enabled; scan ${every / 1000}s; analysis-only, no direct real-money execution`);
  void runSafely();
  setInterval(() => void runSafely(), every);
}
