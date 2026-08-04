import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import {
  evaluateScalpCandidate,
  evaluateScalpConfirmation,
  SCALP_RULES,
} from "./momentumScalperRules";
import type {
  CandidateEvaluation,
  ScalpCandidate,
  ScalpMarketConfirmation,
} from "./momentumScalperRules";
import {
  evaluateMomentumPullback,
  parseGeckoMinuteCandles,
} from "./momentumPullback";
import type { PullbackEvaluation } from "./momentumPullback";

const supabase = getSupabaseAdmin();
const STRATEGY_VERSION = "momentum_entry_safety_v7_2026_08_04";
const REQUEST_TIMEOUT_MS = 12_000;
const DEX_TOKEN_URL = "https://api.dexscreener.com/tokens/v1/solana";
const REQUIRE_PULLBACK = envEnabled("SCALP_REQUIRE_PULLBACK", true);

const GECKO_DISCOVERY_FEEDS = [
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=5m&page=1",
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=1",
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=2",
  "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1",
] as const;

const CANONICAL_MAJOR_MINTS: Record<string, Set<string>> = {
  SOL: new Set(["So11111111111111111111111111111111111111112"]),
  WSOL: new Set(["So11111111111111111111111111111111111111112"]),
  USDC: new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]),
  USDT: new Set(["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]),
};
const GUARDED_MAJOR_SYMBOLS = new Set([
  "SOL", "WSOL", "USDC", "USDT", "BTC", "WBTC", "ETH", "WETH", "BNB", "XRP",
  "ADA", "DOGE", "AVAX", "LINK", "TRX", "DAI", "BUSD", "TUSD", "PYUSD", "EURC",
]);

function applyMajorMintOverrides(): void {
  const raw = process.env.SCALP_MAJOR_SYMBOL_MINTS?.trim();
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, string | string[]>;
    for (const [symbol, values] of Object.entries(parsed)) {
      const mints = Array.isArray(values) ? values : [values];
      CANONICAL_MAJOR_MINTS[symbol.trim().toUpperCase()] = new Set(mints.map(String));
    }
  } catch (error) {
    console.warn("[momentum-scalper] invalid SCALP_MAJOR_SYMBOL_MINTS JSON; using built-in allowlist", error);
  }
}
applyMajorMintOverrides();

type ScalpStateRow = {
  bankroll_sol: number | string;
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  entries_today: number;
  daily_date: string;
};

type DexSnapshot = ScalpMarketConfirmation & {
  pairAddress: string;
};

type EvaluatedCandidate = {
  candidate: ScalpCandidate;
  evaluation: CandidateEvaluation;
};

function envEnabled(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value ? !["0", "false", "no", "off"].includes(value) : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripNetworkId(value: unknown): string {
  return String(value ?? "").replace(/^solana_/, "");
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? "UNKNOWN").split("/")[0].trim().toUpperCase();
}

function isImpersonator(symbol: string, mint: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (!GUARDED_MAJOR_SYMBOLS.has(normalized)) return false;
  return !(CANONICAL_MAJOR_MINTS[normalized]?.has(mint) ?? false);
}

function percentageDifference(next: number, base: number): number {
  return Number.isFinite(next) && Number.isFinite(base) && base > 0
    ? Math.abs((next / base - 1) * 100)
    : Number.POSITIVE_INFINITY;
}

function percentageDrop(next: number, base: number): number {
  return Number.isFinite(next) && Number.isFinite(base) && base > 0
    ? Math.max(0, (1 - next / base) * 100)
    : 100;
}

async function fetchJson(url: string, headers?: HeadersInit): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseCandidate(row: any): ScalpCandidate | null {
  const attributes = row?.attributes;
  const mint = stripNetworkId(row?.relationships?.base_token?.data?.id);
  if (!attributes || !mint) return null;

  const symbol = normalizeSymbol(attributes.name);
  if (isImpersonator(symbol, mint)) return null;
  if (Object.values(CANONICAL_MAJOR_MINTS).some((mints) => mints.has(mint))) return null;

  const pairAddress = String(attributes.address ?? "");
  const createdAt = Date.parse(String(attributes.pool_created_at ?? ""));
  const tx = attributes.transactions?.m5 ?? {};
  const candidate: ScalpCandidate = {
    mint,
    symbol,
    pairAddress,
    priceUsd: numberValue(attributes.base_token_price_usd, NaN),
    liquidityUsd: numberValue(attributes.reserve_in_usd, NaN),
    marketCapUsd: numberValue(attributes.market_cap_usd ?? attributes.fdv_usd, NaN),
    fiveMinuteChangePct: numberValue(attributes.price_change_percentage?.m5, NaN),
    fifteenMinuteChangePct: numberValue(attributes.price_change_percentage?.m15, NaN),
    fiveMinuteVolumeUsd: numberValue(attributes.volume_usd?.m5, NaN),
    fiveMinuteBuys: Math.max(0, Math.floor(numberValue(tx.buys, NaN))),
    fiveMinuteSells: Math.max(0, Math.floor(numberValue(tx.sells, NaN))),
    fiveMinuteBuyers: Math.max(0, Math.floor(numberValue(tx.buyers, NaN))),
    poolAgeMinutes: Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) / 60_000 : NaN,
  };
  return pairAddress && Object.values(candidate).every((value) => typeof value !== "number" || Number.isFinite(value))
    ? candidate
    : null;
}

async function loadCandidates(): Promise<ScalpCandidate[]> {
  const results = await Promise.allSettled(GECKO_DISCOVERY_FEEDS.map((url) => fetchJson(url, {
    Accept: "application/vnd.api+json;version=20230302",
    "User-Agent": "solana-wallet-tracker-paper-scalper/1.0",
  })));
  const byMint = new Map<string, ScalpCandidate>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const row of Array.isArray(result.value?.data) ? result.value.data : []) {
      const candidate = parseCandidate(row);
      if (!candidate) continue;
      const current = byMint.get(candidate.mint);
      if (!current || candidate.liquidityUsd > current.liquidityUsd) byMint.set(candidate.mint, candidate);
    }
  }
  if (results.every((result) => result.status === "rejected")) throw new Error("all GeckoTerminal discovery feeds failed");
  return [...byMint.values()];
}

async function fetchDexSnapshot(mint: string, preferredPair: string): Promise<DexSnapshot> {
  const body = await fetchJson(`${DEX_TOKEN_URL}/${encodeURIComponent(mint)}`, { Accept: "application/json" });
  const pairs = (Array.isArray(body) ? body : []).filter((pair: any) =>
    pair?.chainId === "solana" && pair?.baseToken?.address === mint && numberValue(pair?.priceUsd) > 0
  );
  const pair = pairs.find((item: any) => String(item?.pairAddress ?? "") === preferredPair);
  if (!pair) throw new Error("selected_pair_missing");
  return {
    pairAddress: String(pair.pairAddress),
    priceUsd: numberValue(pair.priceUsd, NaN),
    liquidityUsd: numberValue(pair.liquidity?.usd, NaN),
    marketCapUsd: numberValue(pair.marketCap ?? pair.fdv, NaN),
    fiveMinuteChangePct: numberValue(pair.priceChange?.m5, NaN),
  };
}

async function fetchPullback(pairAddress: string): Promise<PullbackEvaluation> {
  if (!REQUIRE_PULLBACK) {
    return {
      accepted: true,
      reasons: [],
      snapshot: {
        candleCount: 0,
        currentCandleGainPct: null,
        initialMovePct: null,
        pullbackFromHighPct: null,
        recoveryFromLowPct: null,
        shortTermLevelUsd: null,
        currentCloseUsd: null,
        recentHighUsd: null,
        latestCandleTimestampSeconds: null,
      },
    };
  }
  const body = await fetchJson(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(pairAddress)}/ohlcv/minute?aggregate=1&limit=5&currency=usd&token=base`,
    { Accept: "application/vnd.api+json;version=20230302" }
  );
  return evaluateMomentumPullback(parseGeckoMinuteCandles(body));
}

async function loadState(): Promise<ScalpStateRow> {
  const { data, error } = await supabase.from("scalp_state").select("*").eq("id", 1).single();
  if (error) throw error;
  return data as ScalpStateRow;
}

async function resetDaily(state: ScalpStateRow): Promise<ScalpStateRow> {
  const today = new Date().toISOString().slice(0, 10);
  if (state.daily_date === today) return state;
  const { data, error } = await supabase.from("scalp_state").update({
    entries_today: 0,
    daily_date: today,
    daily_realized_pnl_sol: 0,
    consecutive_losses: 0,
    halted: false,
    halt_reason: null,
    updated_at: new Date().toISOString(),
  }).eq("id", 1).select("*").single();
  if (error) throw error;
  return data as ScalpStateRow;
}

async function openPositionCount(): Promise<number> {
  const { count, error } = await supabase.from("scalp_positions").select("position_id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function blocked(mint: string): Promise<boolean> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - SCALP_RULES.cooldownMinutes * 60_000).toISOString();
  const [blacklist, cooldown] = await Promise.all([
    supabase.from("scalp_blacklist").select("mint").eq("mint", mint).gt("blacklisted_until", now).limit(1),
    supabase.from("scalp_trades").select("id").eq("mint", mint).gte("closed_at", cutoff).limit(1),
  ]);
  if (blacklist.error) throw blacklist.error;
  if (cooldown.error) throw cooldown.error;
  return Boolean(blacklist.data?.length || cooldown.data?.length);
}

async function recordScan(startedAt: string, input: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("scalp_scan_runs").insert({
    started_at: startedAt,
    finished_at: now,
    status: input.status ?? "ok",
    scanned_count: input.scannedCount ?? 0,
    qualified_count: input.qualifiedCount ?? 0,
    top_symbol: input.topSymbol ?? null,
    top_mint: input.topMint ?? null,
    top_score: input.topScore ?? null,
    selected_mint: input.selectedMint ?? null,
    message: input.message ?? null,
    top_snapshot: { strategyVersion: STRATEGY_VERSION, requirePullback: REQUIRE_PULLBACK, ...input },
  });
  await supabase.from("scalp_state").update({ last_scan_at: now, updated_at: now }).eq("id", 1);
}

export async function runMomentumScalperScan(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    let state = await resetDaily(await loadState());
    if (!state.enabled || state.halted || state.entries_today >= SCALP_RULES.maxDailyEntries) {
      await recordScan(startedAt, { status: "skipped", message: state.halt_reason ?? "daily_or_state_guard" });
      return;
    }

    let capacity = SCALP_RULES.maxConcurrentPositions - await openPositionCount();
    if (capacity <= 0) {
      await recordScan(startedAt, { status: "skipped", message: "concurrent_position_cap" });
      return;
    }
    capacity = Math.min(capacity, SCALP_RULES.maxDailyEntries - state.entries_today);

    const candidates = await loadCandidates();
    const evaluated: EvaluatedCandidate[] = candidates.map((candidate) => ({
      candidate,
      evaluation: evaluateScalpCandidate(candidate),
    })).sort((a, b) => b.evaluation.score - a.evaluation.score);
    const qualified = evaluated.filter((item) => item.evaluation.accepted);
    const opened: string[] = [];

    for (const item of qualified) {
      if (opened.length >= capacity) break;
      if (isImpersonator(item.candidate.symbol, item.candidate.mint) || await blocked(item.candidate.mint)) continue;

      try {
        const [market, pullback] = await Promise.all([
          fetchDexSnapshot(item.candidate.mint, item.candidate.pairAddress),
          fetchPullback(item.candidate.pairAddress),
        ]);
        const reasons = evaluateScalpConfirmation(market);
        const crossSourceSpreadPct = percentageDifference(market.priceUsd, item.candidate.priceUsd);
        const liquidityDropPct = percentageDrop(market.liquidityUsd, item.candidate.liquidityUsd);
        if (market.pairAddress !== item.candidate.pairAddress) reasons.push("selected_pair_mismatch");
        if (crossSourceSpreadPct > SCALP_RULES.maxEntryPriceGapPct) reasons.push("cross_source_spread_too_wide");
        if (liquidityDropPct > SCALP_RULES.maxLiquidityDropPct) reasons.push("liquidity_dropped_before_entry");
        if (REQUIRE_PULLBACK) reasons.push(...pullback.reasons);
        if (reasons.length) continue;

        const sizeSol = Math.min(SCALP_RULES.fixedSizeSol, numberValue(state.bankroll_sol));
        if (sizeSol < SCALP_RULES.fixedSizeSol) break;
        const positionId = `scalp_${randomUUID()}`;
        const openedAt = new Date().toISOString();
        const entrySnapshot = {
          strategyVersion: STRATEGY_VERSION,
          source: "geckoterminal_plus_dexscreener",
          candidate: item.candidate,
          score: item.evaluation.score,
          dexConfirmation: market,
          pullback,
          requirePullback: REQUIRE_PULLBACK,
          crossSourceSpreadPct,
          liquidityDropPct,
          paperOnly: true,
        };
        const { error } = await supabase.rpc("open_paper_scalp", {
          p_position_id: positionId,
          p_mint: item.candidate.mint,
          p_token_symbol: item.candidate.symbol,
          p_pair_address: market.pairAddress,
          p_entry_price_usd: market.priceUsd,
          p_entry_time: openedAt,
          p_size_sol: sizeSol,
          p_entry_snapshot: entrySnapshot,
        });
        if (error) throw error;
        opened.push(item.candidate.mint);
        state.entries_today += 1;
        console.log(`[MOMENTUM SCALP OPEN] ${item.candidate.symbol} score=${item.evaluation.score} spread=${crossSourceSpreadPct.toFixed(2)}%`);
        try {
          await sendTelegramAlert(`⚡ <b>PAPER MOMENTUM SCALP OPENED</b>\n\n🪙 <b>${item.candidate.symbol}</b>\nSize: <b>${sizeSol.toFixed(3)} SOL</b>\nScore: <b>${item.evaluation.score}/100</b>\nPullback required: <b>${REQUIRE_PULLBACK}</b>\n\n🧪 Paper only.`);
        } catch {}
      } catch (error) {
        console.warn(`[momentum-scalper] entry validation failed for ${item.candidate.symbol}`, error);
      }
    }

    const top = evaluated[0];
    await recordScan(startedAt, {
      status: "ok",
      scannedCount: candidates.length,
      qualifiedCount: qualified.length,
      topSymbol: top?.candidate.symbol,
      topMint: top?.candidate.mint,
      topScore: top?.evaluation.score,
      selectedMint: opened[0] ?? null,
      openedMints: opened,
      message: opened.length ? `opened_${opened.length}` : "no_entry",
    });
    console.log(`[momentum-scalper] scanned=${candidates.length} qualified=${qualified.length} opened=${opened.length} capacity=${capacity}`);
  } catch (error) {
    console.error("[momentum-scalper] scan failed", error);
    await recordScan(startedAt, { status: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
