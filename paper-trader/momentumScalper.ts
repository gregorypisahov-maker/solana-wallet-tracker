import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import {
  CandidateEvaluation,
  calculateNetMultiple,
  decideScalpExit,
  evaluateScalpCandidate,
  evaluateScalpConfirmation,
  SCALP_RULES,
  ScalpCandidate,
  ScalpMarketConfirmation,
} from "./momentumScalperRules";

const supabase = getSupabaseAdmin();
const GECKO_DISCOVERY_FEEDS = [
  {
    name: "trending_5m_page_1",
    url: "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=5m&page=1",
  },
  {
    name: "trending_1h_page_1",
    url: "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=1",
  },
  {
    name: "trending_1h_page_2",
    url: "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=2",
  },
  {
    name: "new_pools_page_1",
    url: "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1",
  },
] as const;
const DEX_TOKEN_URL = "https://api.dexscreener.com/tokens/v1/solana";
const REQUEST_TIMEOUT_MS = 12_000;
const STRATEGY_VERSION = "momentum_expanded_profile_v5_2026_07_18";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLE_MINTS = new Set([
  WRAPPED_SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

type ScalpStateRow = {
  bankroll_sol: number | string;
  starting_bankroll_sol: number | string;
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  entries_today: number;
  daily_date: string;
  daily_realized_pnl_sol: number | string;
  consecutive_losses: number;
  last_scan_at: string | null;
};

type ScalpPositionRow = {
  position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  entry_price_usd: number | string;
  entry_time: string;
  size_sol: number | string;
  peak_price_usd: number | string;
  last_price_usd: number | string;
  entry_snapshot: Record<string, unknown>;
};

type DexSnapshot = ScalpMarketConfirmation & {
  pairAddress: string;
};

type EvaluatedCandidate = {
  candidate: ScalpCandidate;
  evaluation: CandidateEvaluation;
};

let scanRunning = false;
let positionCheckRunning = false;

function boundedInterval(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

const SCAN_INTERVAL_MS = boundedInterval(
  process.env.SCALP_SCAN_INTERVAL_MS,
  60_000,
  30_000,
  5 * 60_000
);
const POSITION_CHECK_INTERVAL_MS = boundedInterval(
  process.env.SCALP_POSITION_CHECK_MS,
  3_000,
  3_000,
  60_000
);

function envEnabled(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripNetworkId(value: unknown): string {
  return String(value ?? "").replace(/^solana_/, "");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function signed(value: number, digits = 3): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

async function fetchJson(url: string, headers?: HeadersInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseTrendingCandidate(row: any): ScalpCandidate | null {
  const attributes = row?.attributes;
  const baseMint = stripNetworkId(
    row?.relationships?.base_token?.data?.id
  );
  if (!attributes || !baseMint || STABLE_MINTS.has(baseMint)) return null;

  const priceUsd = numberValue(attributes.base_token_price_usd, NaN);
  const liquidityUsd = numberValue(attributes.reserve_in_usd, NaN);
  const marketCapUsd = numberValue(
    attributes.market_cap_usd ?? attributes.fdv_usd,
    NaN
  );
  const pairAddress = String(attributes.address ?? "");
  const createdAt = Date.parse(String(attributes.pool_created_at ?? ""));
  const poolAgeMinutes = Number.isFinite(createdAt)
    ? Math.max(0, Date.now() - createdAt) / 60_000
    : 0;

  if (
    !pairAddress ||
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0 ||
    !Number.isFinite(liquidityUsd) ||
    !Number.isFinite(marketCapUsd)
  ) {
    return null;
  }

  const symbol =
    String(attributes.name ?? "UNKNOWN").split("/")[0]?.trim() || "UNKNOWN";
  const transactions = attributes.transactions?.m5 ?? {};

  return {
    mint: baseMint,
    symbol,
    pairAddress,
    priceUsd,
    liquidityUsd,
    marketCapUsd,
    fiveMinuteChangePct: numberValue(
      attributes.price_change_percentage?.m5
    ),
    fifteenMinuteChangePct: numberValue(
      attributes.price_change_percentage?.m15
    ),
    fiveMinuteVolumeUsd: numberValue(attributes.volume_usd?.m5),
    fiveMinuteBuys: Math.max(0, Math.floor(numberValue(transactions.buys))),
    fiveMinuteSells: Math.max(0, Math.floor(numberValue(transactions.sells))),
    fiveMinuteBuyers: Math.max(
      0,
      Math.floor(numberValue(transactions.buyers))
    ),
    poolAgeMinutes,
  };
}

async function loadTrendingCandidates(): Promise<ScalpCandidate[]> {
  const results = await Promise.allSettled(
    GECKO_DISCOVERY_FEEDS.map(async (feed) => ({
      feed,
      body: (await fetchJson(feed.url, {
        Accept: "application/vnd.api+json;version=20230302",
        "User-Agent": "solana-wallet-tracker-paper-scalper/1.0",
      })) as any,
    }))
  );
  const successful = results.filter(
    (result): result is PromiseFulfilledResult<{
      feed: (typeof GECKO_DISCOVERY_FEEDS)[number];
      body: any;
    }> => result.status === "fulfilled"
  );

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[momentum-scalper] discovery feed failed:", result.reason);
    }
  }
  if (successful.length === 0) {
    throw new Error("all GeckoTerminal discovery feeds failed");
  }

  const byMint = new Map<string, ScalpCandidate>();

  for (const { value } of successful) {
    const rows = Array.isArray(value.body?.data) ? value.body.data : [];
    for (const row of rows) {
      const candidate = parseTrendingCandidate(row);
      if (!candidate) continue;
      const existing = byMint.get(candidate.mint);
      if (!existing || candidate.liquidityUsd > existing.liquidityUsd) {
        byMint.set(candidate.mint, candidate);
      }
    }
  }
  return [...byMint.values()];
}

async function fetchDexSnapshot(mint: string): Promise<DexSnapshot> {
  const body = await fetchJson(
    `${DEX_TOKEN_URL}/${encodeURIComponent(mint)}`,
    { Accept: "application/json" }
  );
  const pairs = Array.isArray(body) ? body : [];
  const eligible = pairs
    .filter(
      (pair: any) =>
        pair?.chainId === "solana" &&
        pair?.baseToken?.address === mint &&
        numberValue(pair?.priceUsd) > 0
    )
    .sort(
      (left: any, right: any) =>
        numberValue(right?.liquidity?.usd) -
        numberValue(left?.liquidity?.usd)
    );

  const pair = eligible[0];
  if (!pair) throw new Error(`No liquid DexScreener pair for ${mint}`);

  return {
    pairAddress: String(pair.pairAddress ?? ""),
    priceUsd: numberValue(pair.priceUsd),
    liquidityUsd: numberValue(pair.liquidity?.usd),
    marketCapUsd: numberValue(pair.marketCap ?? pair.fdv),
    fiveMinuteChangePct: numberValue(pair.priceChange?.m5),
  };
}

async function loadState(): Promise<ScalpStateRow> {
  const { data, error } = await supabase
    .from("scalp_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`scalp state load failed: ${error.message}`);
  return data as ScalpStateRow;
}

async function loadPositions(): Promise<ScalpPositionRow[]> {
  const { data, error } = await supabase
    .from("scalp_positions")
    .select("*")
    .order("entry_time", { ascending: true });
  if (error) throw new Error(`scalp position load failed: ${error.message}`);
  return (data ?? []) as ScalpPositionRow[];
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function resetDailyRiskIfNeeded(
  state: ScalpStateRow
): Promise<ScalpStateRow> {
  if (state.daily_date === utcDate()) return state;

  const { data, error } = await supabase
    .from("scalp_state")
    .update({
      entries_today: 0,
      daily_date: utcDate(),
      daily_realized_pnl_sol: 0,
      consecutive_losses: 0,
      halted: false,
      halt_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1)
    .select("*")
    .single();
  if (error) throw new Error(`scalp daily reset failed: ${error.message}`);
  return data as ScalpStateRow;
}

async function isCoolingDown(mint: string): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - SCALP_RULES.cooldownMinutes * 60_000
  ).toISOString();
  const { data, error } = await supabase
    .from("scalp_trades")
    .select("id")
    .eq("mint", mint)
    .gte("closed_at", cutoff)
    .limit(1);
  if (error) throw new Error(`scalp cooldown lookup failed: ${error.message}`);
  return Boolean(data?.length);
}

async function recordScan(input: {
  startedAt: string;
  status: "ok" | "error" | "skipped";
  scannedCount?: number;
  qualifiedCount?: number;
  top?: EvaluatedCandidate | null;
  selectedMint?: string | null;
  message?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("scalp_scan_runs").insert({
    started_at: input.startedAt,
    finished_at: now,
    status: input.status,
    scanned_count: input.scannedCount ?? 0,
    qualified_count: input.qualifiedCount ?? 0,
    top_symbol: input.top?.candidate.symbol ?? null,
    top_mint: input.top?.candidate.mint ?? null,
    top_score: input.top?.evaluation.score ?? null,
    selected_mint: input.selectedMint ?? null,
    message: input.message ?? null,
    top_snapshot: input.top
      ? { ...input.top, strategyVersion: STRATEGY_VERSION }
      : { strategyVersion: STRATEGY_VERSION },
  });
  if (error) {
    console.error("[momentum-scalper] scan audit insert failed:", error);
  }

  await supabase
    .from("scalp_state")
    .update({ last_scan_at: now, updated_at: now })
    .eq("id", 1);

  if (Math.random() < 0.02) {
    await supabase
      .from("scalp_scan_runs")
      .delete()
      .lt("started_at", new Date(Date.now() - 30 * 86_400_000).toISOString());
  }
}

async function openScalp(
  state: ScalpStateRow,
  selected: EvaluatedCandidate,
  market: DexSnapshot
): Promise<void> {
  const candidate = selected.candidate;

  const sizeSol = Math.min(
    SCALP_RULES.fixedSizeSol,
    numberValue(state.bankroll_sol)
  );
  if (sizeSol < SCALP_RULES.fixedSizeSol) {
    throw new Error(`paper bankroll below the fixed ${SCALP_RULES.fixedSizeSol.toFixed(2)} SOL scalp size`);
  }

  const openedAt = new Date().toISOString();
  const positionId = `scalp_${randomUUID()}`;
  const entrySnapshot = {
    strategyVersion: STRATEGY_VERSION,
    source: "geckoterminal_trending_and_new",
    candidate,
    score: selected.evaluation.score,
    dexConfirmation: market,
    friction: {
      entryPct: SCALP_RULES.entryFrictionPct,
      exitPct: SCALP_RULES.exitFrictionPct,
    },
  };

  const { error } = await supabase.rpc("open_paper_scalp", {
    p_position_id: positionId,
    p_mint: candidate.mint,
    p_token_symbol: candidate.symbol,
    p_pair_address: market.pairAddress || candidate.pairAddress,
    p_entry_price_usd: market.priceUsd,
    p_entry_time: openedAt,
    p_size_sol: sizeSol,
    p_entry_snapshot: entrySnapshot,
  });
  if (error) throw new Error(`paper scalp open failed: ${error.message}`);

  console.log(
    `[MOMENTUM SCALP OPEN] ${candidate.symbol} | ${sizeSol.toFixed(3)} SOL | ` +
      `m5 ${signed(candidate.fiveMinuteChangePct, 1)}% | score ${selected.evaluation.score}`
  );

  await sendTelegramAlert(
    [
      "⚡ <b>PAPER MOMENTUM SCALP OPENED</b>",
      "",
      `🪙 <b>${escapeHtml(candidate.symbol)}</b>`,
      `Size: <b>${sizeSol.toFixed(3)} SOL</b>`,
      `5m discovery: <b>${signed(candidate.fiveMinuteChangePct, 1)}%</b>`,
      `5m confirmation: <b>${signed(market.fiveMinuteChangePct, 1)}%</b>`,
      `5m volume: <b>$${Math.round(candidate.fiveMinuteVolumeUsd).toLocaleString()}</b>`,
      `Liquidity: <b>$${Math.round(market.liquidityUsd).toLocaleString()}</b>`,
      `Signal score: <b>${selected.evaluation.score}/100</b>`,
      "",
      "Target: +4.5% net • Stop: -3.0% net • Max hold: 10 min",
      "Includes 1.2% simulated round-trip friction.",
      "",
      `<a href="https://dexscreener.com/solana/${candidate.mint}">Open DexScreener</a>`,
      "",
      "🧪 Paper only — no real wallet or SOL is connected.",
    ].join("\n")
  );
}

export async function runMomentumScalperScan(): Promise<void> {
  const startedAt = new Date().toISOString();

  try {
    let state = await loadState();
    state = await resetDailyRiskIfNeeded(state);

    if (
      state.enabled &&
      !state.halted &&
      state.entries_today >= SCALP_RULES.maxDailyEntries
    ) {
      const { data, error } = await supabase
        .from("scalp_state")
        .update({
          halted: true,
          halt_reason: "daily_entry_limit",
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1)
        .select("*")
        .single();
      if (error) {
        throw new Error(`scalp daily-entry halt failed: ${error.message}`);
      }
      state = data as ScalpStateRow;
    }

    if (!state.enabled || state.halted) {
      await recordScan({
        startedAt,
        status: "skipped",
        message: !state.enabled
          ? "scalper_disabled"
          : state.halt_reason ?? "risk_guard_halted",
      });
      return;
    }

    const positions = await loadPositions();
    if (positions.length > 0) return;

    const candidates = await loadTrendingCandidates();
    const evaluated = candidates
      .map((candidate) => ({
        candidate,
        evaluation: evaluateScalpCandidate(candidate),
      }))
      .sort((left, right) => right.evaluation.score - left.evaluation.score);
    const qualified = evaluated.filter((item) => item.evaluation.accepted);
    let selected: EvaluatedCandidate | null = null;
    let selectedMarket: DexSnapshot | null = null;
    let confirmationRejections = 0;
    const confirmationRejectionReasons = new Set<string>();
    let cooldownRejections = 0;

    for (const item of qualified) {
      if (await isCoolingDown(item.candidate.mint)) {
        cooldownRejections += 1;
        continue;
      }

      try {
        const market = await fetchDexSnapshot(item.candidate.mint);
        const confirmationReasons = evaluateScalpConfirmation(market);
        if (confirmationReasons.length > 0) {
          confirmationRejections += 1;
          for (const reason of confirmationReasons) {
            confirmationRejectionReasons.add(reason);
          }
          console.log(
            `[MOMENTUM SCALP REJECT] ${item.candidate.symbol}: ` +
              confirmationReasons.join(",")
          );
          continue;
        }
        selected = item;
        selectedMarket = market;
        break;
      } catch (error) {
        confirmationRejections += 1;
        confirmationRejectionReasons.add("dex_fetch_failed");
        console.warn(
          `[momentum-scalper] Dex confirmation failed for ${item.candidate.symbol}:`,
          error
        );
      }
    }

    if (selected && selectedMarket) {
      await openScalp(state, selected, selectedMarket);
    }

    const top = evaluated[0] ?? null;
    const message = selected
      ? "paper_scalp_opened"
      : confirmationRejections > 0
        ? `dex_confirmation_rejected:${confirmationRejections}:${[
            ...confirmationRejectionReasons,
          ]
            .slice(0, 3)
            .join(",")}`
        : cooldownRejections > 0
          ? "qualified_candidates_in_cooldown"
          : top
            ? `no_entry: ${top.evaluation.reasons.slice(0, 3).join(",")}`
            : "no_trending_candidates";

    await recordScan({
      startedAt,
      status: "ok",
      scannedCount: candidates.length,
      qualifiedCount: qualified.length,
      top,
      selectedMint: selected?.candidate.mint ?? null,
      message,
    });

    console.log(
      `[momentum-scalper] scanned ${candidates.length}; qualified ${qualified.length}; ` +
        `${selected ? `opened ${selected.candidate.symbol}` : message}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[momentum-scalper] scan failed:", error);
    await recordScan({ startedAt, status: "error", message });
  }
}

export async function checkMomentumScalpPositions(): Promise<void> {
  const positions = await loadPositions();

  for (const position of positions) {
    try {
      const market = await fetchDexSnapshot(position.mint);
      const entryPriceUsd = numberValue(position.entry_price_usd);
      const peakPriceUsd = Math.max(
        numberValue(position.peak_price_usd),
        market.priceUsd
      );
      const nowMs = Date.now();
      const decision = decideScalpExit({
        entryPriceUsd,
        currentPriceUsd: market.priceUsd,
        peakPriceUsd,
        openedAtMs: Date.parse(position.entry_time),
        nowMs,
      });
      const now = new Date(nowMs).toISOString();

      if (!decision) {
        const { error } = await supabase
          .from("scalp_positions")
          .update({
            peak_price_usd: peakPriceUsd,
            last_price_usd: market.priceUsd,
            last_checked_at: now,
            updated_at: now,
          })
          .eq("position_id", position.position_id);
        if (error) {
          throw new Error(`scalp mark update failed: ${error.message}`);
        }
        continue;
      }

      const sizeSol = numberValue(position.size_sol);
      const proceedsSol = sizeSol * decision.netMultiple;
      const pnlSol = proceedsSol - sizeSol;
      const exitSnapshot = {
        source: "dexscreener",
        market,
        peakPriceUsd,
        priceMultiple: market.priceUsd / entryPriceUsd,
        netMultiple: decision.netMultiple,
        friction: {
          entryPct: SCALP_RULES.entryFrictionPct,
          exitPct: SCALP_RULES.exitFrictionPct,
        },
      };

      const { data, error } = await supabase.rpc("close_paper_scalp", {
        p_position_id: position.position_id,
        p_exit_price_usd: market.priceUsd,
        p_gross_return_pct: decision.grossReturnPct,
        p_net_return_pct: decision.netReturnPct,
        p_pnl_sol: pnlSol,
        p_proceeds_sol: proceedsSol,
        p_exit_reason: decision.reason,
        p_closed_at: now,
        p_exit_snapshot: exitSnapshot,
      });
      if (error) throw new Error(`paper scalp close failed: ${error.message}`);

      const closeResult = (data ?? {}) as Record<string, unknown>;
      const bankrollSol = numberValue(closeResult.bankrollSol, NaN);
      const profitable = pnlSol >= 0;
      console.log(
        `[MOMENTUM SCALP CLOSE] ${position.token_symbol} | ${decision.reason} | ` +
          `net ${signed(decision.netReturnPct, 2)}% | PnL ${signed(pnlSol, 5)} SOL`
      );

      await sendTelegramAlert(
        [
          `${profitable ? "✅" : "🔴"} <b>PAPER MOMENTUM SCALP CLOSED</b>`,
          "",
          `🪙 <b>${escapeHtml(position.token_symbol)}</b>`,
          `Reason: <b>${decision.reason.replaceAll("_", " ")}</b>`,
          `Gross move: <b>${signed(decision.grossReturnPct, 2)}%</b>`,
          `Net after friction: <b>${signed(decision.netReturnPct, 2)}%</b>`,
          `Paper PnL: <b>${signed(pnlSol, 5)} SOL</b>`,
          Number.isFinite(bankrollSol)
            ? `Scalper bankroll: <b>${bankrollSol.toFixed(4)} SOL</b>`
            : "",
          closeResult.halted
            ? `🛑 Risk guard: <b>${escapeHtml(closeResult.haltReason)}</b>`
            : "",
          "",
          "🧪 Paper only — this is measured simulation, not guaranteed profit.",
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (error) {
      console.error(
        `[momentum-scalper] ${position.token_symbol} position check failed:`,
        error
      );
    }
  }
}

async function scanSafely(): Promise<void> {
  if (scanRunning) return;
  scanRunning = true;
  try {
    await runMomentumScalperScan();
  } finally {
    scanRunning = false;
  }
}

async function checkPositionsSafely(): Promise<void> {
  if (positionCheckRunning) return;
  positionCheckRunning = true;
  try {
    await checkMomentumScalpPositions();
  } finally {
    positionCheckRunning = false;
  }
}

export function startMomentumScalperScheduler(): void {
  if (!envEnabled("ENABLE_MOMENTUM_SCALPER", true)) {
    console.log("[momentum-scalper] disabled by ENABLE_MOMENTUM_SCALPER");
    return;
  }

  console.log(
    `[momentum-scalper] paper-only wallet-free strategy enabled; ` +
      `scan ${SCAN_INTERVAL_MS / 1000}s; position check ${POSITION_CHECK_INTERVAL_MS / 1000}s; ` +
      `size ${SCALP_RULES.fixedSizeSol.toFixed(2)} SOL`
  );

  void scanSafely().catch((error) =>
    console.error("[momentum-scalper] initial scan failed:", error)
  );
  void checkPositionsSafely().catch((error) =>
    console.error("[momentum-scalper] initial position check failed:", error)
  );

  setInterval(() => {
    void scanSafely().catch((error) =>
      console.error("[momentum-scalper] scheduled scan failed:", error)
    );
  }, SCAN_INTERVAL_MS);

  setInterval(() => {
    void checkPositionsSafely().catch((error) =>
      console.error("[momentum-scalper] scheduled position check failed:", error)
    );
  }, POSITION_CHECK_INTERVAL_MS);
}
