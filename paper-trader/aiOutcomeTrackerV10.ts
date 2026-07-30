import { geckoFetchJson } from "../lib/geckoFetch";
import { getPriceViaHelius } from "../lib/heliusPrice";
import { getSupabaseAdmin } from "../lib/supabase";
import { FetchPriority, fetchJsonQueued } from "./fetchQueue";

const supabase = getSupabaseAdmin();
const VERSION = "ai_outcome_tracker_v11_2026_07_30";
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const GECKO_POOL_URL = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const SAMPLE_RATE = Math.min(1, Math.max(0, Number(process.env.AI_OUTCOME_SAMPLE_RATE) || 0.1));
const BATCH_SIZE = Math.max(1, Math.min(25, Number(process.env.AI_OUTCOME_BATCH_SIZE) || 8));
const HORIZONS = [5, 15, 30, 45] as const;
const TOLERANCE_MS: Record<Horizon, number> = {
  5: 90_000,
  15: 120_000,
  30: 180_000,
  45: 180_000,
};
const CYCLE_MS = Math.max(15_000, Number(process.env.AI_OUTCOME_CYCLE_MS) || 30_000);

type Horizon = (typeof HORIZONS)[number];
type HorizonState = "pending" | "due" | "missed";
type PriceSource = "helius" | "cache" | "dexscreener" | "geckoterminal";
type PriceMeasurement = {
  priceUsd: number;
  measuredAt: string;
  source: PriceSource;
};
type MeasurementAttempt = {
  measurement: PriceMeasurement | null;
  error: string | null;
  dex429: boolean;
  usedFallback: boolean;
};
type CycleStats = {
  due: number;
  measured: number;
  missed: number;
  failed: number;
  dexRequests: number;
  dex429: number;
  geckoFallbacks: number;
  heliusRequests: number;
  heliusHits: number;
  heliusCacheHits: number;
};

let running = false;

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positivePrice(value: unknown): number | null {
  const parsed = n(value, Number.NaN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relationMatchesMint(id: unknown, mint: string): boolean {
  const value = String(id ?? "");
  return value === mint || value.endsWith(`_${mint}`) || value.endsWith(`:${mint}`);
}

export function horizonState(
  observedAt: string,
  horizon: Horizon,
  atMs = Date.now()
): HorizonState {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return "missed";
  const targetMs = observedMs + horizon * 60_000;
  const tolerance = TOLERANCE_MS[horizon];
  if (atMs < targetMs - tolerance) return "pending";
  if (atMs > targetMs + tolerance) return "missed";
  return "due";
}

function parseDexPrice(body: unknown, mint: string, pairAddress: string): number | null {
  const pairs = Array.isArray(body) ? body : [];
  const pair = pairs.find(
    (item: any) =>
      item?.chainId === "solana" &&
      String(item?.pairAddress ?? "") === pairAddress &&
      item?.baseToken?.address === mint
  );
  return positivePrice(pair?.priceUsd);
}

function parseGeckoPrice(body: any, mint: string): number | null {
  const attributes = body?.data?.attributes ?? null;
  const relationships = body?.data?.relationships ?? null;
  if (!attributes) return null;

  const baseId = relationships?.base_token?.data?.id;
  if (relationMatchesMint(baseId, mint)) {
    return positivePrice(attributes.base_token_price_usd);
  }

  const quoteId = relationships?.quote_token?.data?.id;
  if (relationMatchesMint(quoteId, mint)) {
    return positivePrice(attributes.quote_token_price_usd);
  }

  return null;
}

async function dexPrice(mint: string, pairAddress: string): Promise<PriceMeasurement | null> {
  const body = await fetchJsonQueued(`${DEX_URL}/${encodeURIComponent(mint)}`, {
    priority: FetchPriority.LOW,
    timeoutMs: 12_000,
    cacheTtlMs: 0,
    headers: { Accept: "application/json" },
  });
  const priceUsd = parseDexPrice(body, mint, pairAddress);
  return priceUsd == null
    ? null
    : { priceUsd, measuredAt: new Date().toISOString(), source: "dexscreener" };
}

async function geckoPrice(mint: string, pairAddress: string): Promise<PriceMeasurement | null> {
  const body = await geckoFetchJson<any>(
    `${GECKO_POOL_URL}/${encodeURIComponent(pairAddress)}`
  );
  const priceUsd = parseGeckoPrice(body, mint);
  return priceUsd == null
    ? null
    : { priceUsd, measuredAt: new Date().toISOString(), source: "geckoterminal" };
}

async function pairMeasurement(
  mint: string,
  pairAddress: string,
  stats?: CycleStats
): Promise<MeasurementAttempt> {
  if (stats) stats.heliusRequests += 1;
  const helius = await getPriceViaHelius(mint, pairAddress);
  if (helius) {
    if (stats) {
      stats.heliusHits += 1;
      if (helius.source === "cache") stats.heliusCacheHits += 1;
    }
    console.log(`[outcome-tracker] price ${mint} src=${helius.source} poolProgram=${helius.poolProgram}`);
    return {
      measurement: {
        priceUsd: helius.priceUsd,
        measuredAt: helius.observedAt,
        source: helius.source,
      },
      error: null,
      dex429: false,
      usedFallback: false,
    };
  }

  let dexError: string | null = null;
  if (stats) stats.dexRequests += 1;

  try {
    const measurement = await dexPrice(mint, pairAddress);
    if (measurement) {
      console.log(`[outcome-tracker] price ${mint} src=dex poolProgram=fallback`);
      return { measurement, error: null, dex429: false, usedFallback: false };
    }
    dexError = "DexScreener pair price unavailable";
  } catch (error) {
    dexError = formatError(error);
  }

  const dex429 = /(^|\s)429(\s|$)|too many requests/i.test(dexError ?? "");
  if (stats && dex429) stats.dex429 += 1;

  try {
    const measurement = await geckoPrice(mint, pairAddress);
    if (measurement) {
      if (stats) stats.geckoFallbacks += 1;
      console.log(`[outcome-tracker] price ${mint} src=gecko poolProgram=fallback`);
      return { measurement, error: dexError, dex429, usedFallback: true };
    }
    return {
      measurement: null,
      error: [dexError, "GeckoTerminal pair price unavailable"].filter(Boolean).join("; "),
      dex429,
      usedFallback: true,
    };
  } catch (error) {
    return {
      measurement: null,
      error: [dexError, `GeckoTerminal: ${formatError(error)}`].filter(Boolean).join("; "),
      dex429,
      usedFallback: true,
    };
  }
}

async function decideNewSamples(): Promise<void> {
  const cutoff = new Date(Date.now() - 3 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("ai_candidate_observations")
    .select("id,mint,pair_address,entered,entry_price_usd,observed_at,outcome_quality")
    .eq("outcome_tracked", false)
    .is("outcome_quality", null)
    .gte("observed_at", cutoff)
    .order("observed_at", { ascending: true })
    .limit(40);
  if (error) throw new Error(error.message);

  for (const row of data ?? []) {
    const forced = Boolean(row.entered);
    const selected = forced || Math.random() < SAMPLE_RATE;
    if (!selected) {
      await supabase
        .from("ai_candidate_observations")
        .update({ outcome_quality: "not_sampled", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      continue;
    }

    let price = forced ? n(row.entry_price_usd, 0) : 0;
    let measuredAt = forced ? row.observed_at : null;
    let source = forced ? "entered_trade" : "random";
    let baselineError: string | null = null;

    if (price <= 0 && row.pair_address) {
      const attempt = await pairMeasurement(row.mint, row.pair_address);
      price = attempt.measurement?.priceUsd ?? 0;
      measuredAt = attempt.measurement?.measuredAt ?? null;
      baselineError = attempt.error;
      if (attempt.measurement) source = `random_${attempt.measurement.source}`;
    }

    const now = new Date().toISOString();
    await supabase
      .from("ai_candidate_observations")
      .update({
        outcome_tracked: price > 0,
        outcome_sample_source: source,
        observed_price_usd: price > 0 ? price : null,
        observed_price_at: price > 0 ? measuredAt ?? now : null,
        outcome_quality: price > 0 ? null : "missing_baseline",
        outcome_complete: price <= 0,
        last_outcome_error: price > 0 ? null : baselineError,
        updated_at: now,
      })
      .eq("id", row.id);
  }
}

async function promoteEnteredRows(): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("ai_candidate_observations")
    .select("id,entry_price_usd,observed_at")
    .eq("entered", true)
    .eq("outcome_tracked", false)
    .gte("observed_at", cutoff)
    .limit(50);
  if (error) throw new Error(error.message);

  const now = new Date().toISOString();
  for (const row of data ?? []) {
    const price = n(row.entry_price_usd, 0);
    if (price <= 0) continue;
    await supabase
      .from("ai_candidate_observations")
      .update({
        outcome_tracked: true,
        outcome_sample_source: "entered_trade",
        observed_price_usd: price,
        observed_price_at: row.observed_at ?? now,
        outcome_quality: null,
        outcome_complete: false,
        updated_at: now,
      })
      .eq("id", row.id);
  }
}

function rowResolved(
  row: any,
  updates: Record<string, unknown>,
  misses: Set<string>,
  horizon: Horizon
): boolean {
  return updates[`price_${horizon}m_usd`] != null ||
    row[`price_${horizon}m_usd`] != null ||
    misses.has(`${horizon}m`);
}

async function trackDueOutcomes(): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("ai_candidate_observations")
    .select("*")
    .eq("outcome_tracked", true)
    .eq("outcome_complete", false)
    .gte("observed_at", cutoff)
    .order("observed_at", { ascending: true })
    .limit(250);
  if (error) throw new Error(error.message);

  const nowMs = Date.now();
  const actionable = (data ?? [])
    .map((row: any) => {
      const misses = new Set<string>(Array.isArray(row.horizon_misses) ? row.horizon_misses : []);
      const unresolved = HORIZONS.filter(
        (horizon) => row[`price_${horizon}m_usd`] == null && !misses.has(`${horizon}m`)
      );
      const firstActionable = unresolved.find(
        (horizon) => horizonState(row.observed_at, horizon, nowMs) !== "pending"
      );
      if (!firstActionable) return null;
      return {
        row,
        targetMs: Date.parse(row.observed_at) + firstActionable * 60_000,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.targetMs - b.targetMs)
    .slice(0, BATCH_SIZE) as Array<{ row: any; targetMs: number }>;

  const stats: CycleStats = {
    due: 0,
    measured: 0,
    missed: 0,
    failed: 0,
    dexRequests: 0,
    dex429: 0,
    geckoFallbacks: 0,
    heliusRequests: 0,
    heliusHits: 0,
    heliusCacheHits: 0,
  };

  for (const { row } of actionable) {
    const misses = new Set<string>(Array.isArray(row.horizon_misses) ? row.horizon_misses : []);
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    let dueHorizon: Horizon | null = null;
    let newlyMissed = 0;

    for (const horizon of HORIZONS) {
      const label = `${horizon}m`;
      if (row[`price_${horizon}m_usd`] != null || misses.has(label)) continue;
      const state = horizonState(row.observed_at, horizon);
      if (state === "missed") {
        misses.add(label);
        newlyMissed += 1;
      } else if (state === "due" && dueHorizon == null) {
        dueHorizon = horizon;
      }
    }

    if (newlyMissed > 0) {
      stats.missed += newlyMissed;
      updates.horizon_misses = [...misses];
      updates.last_outcome_error = `missed_horizon_window:${[...misses].join(",")}`;
    }

    if (dueHorizon != null) {
      stats.due += 1;
      const attemptAt = new Date().toISOString();
      updates.last_outcome_attempt_at = attemptAt;
      updates.outcome_fetch_attempts = n(row.outcome_fetch_attempts) + 1;

      const attempt = await pairMeasurement(row.mint, row.pair_address, stats);
      const measurement = attempt.measurement;
      if (measurement) {
        const measuredMs = Date.parse(measurement.measuredAt);
        const targetMs = Date.parse(row.observed_at) + dueHorizon * 60_000;
        const tolerance = TOLERANCE_MS[dueHorizon];
        if (!Number.isFinite(measuredMs) || measuredMs > targetMs + tolerance) {
          const label = `${dueHorizon}m`;
          if (!misses.has(label)) {
            misses.add(label);
            stats.missed += 1;
          }
          updates.horizon_misses = [...misses];
          updates.last_outcome_error = `late_measurement_rejected:${label}:${measurement.source}`;
        } else {
          const base = n(row.observed_price_usd, 0);
          updates[`price_${dueHorizon}m_usd`] = measurement.priceUsd;
          updates[`price_${dueHorizon}m_at`] = measurement.measuredAt;
          updates[`return_${dueHorizon}m_pct`] =
            base > 0
              ? Number((((measurement.priceUsd / base) - 1) * 100).toFixed(4))
              : null;
          updates.last_outcome_error = null;
          stats.measured += 1;
        }
      } else {
        updates.last_outcome_error = (attempt.error ?? "all price providers unavailable").slice(0, 500);
        stats.failed += 1;
      }
    }

    const resolved = HORIZONS.every((horizon) => rowResolved(row, updates, misses, horizon));
    if (resolved) {
      const measuredCount = HORIZONS.filter(
        (horizon) => updates[`price_${horizon}m_usd`] != null || row[`price_${horizon}m_usd`] != null
      ).length;
      updates.outcome_complete = true;
      updates.outcome_quality = measuredCount === 4 ? "on_time" : measuredCount > 0 ? "partial" : "missed";
    }

    const { error: updateError } = await supabase
      .from("ai_candidate_observations")
      .update(updates)
      .eq("id", row.id);
    if (updateError) throw new Error(updateError.message);
  }

  const { count: backlog } = await supabase
    .from("ai_candidate_observations")
    .select("id", { count: "exact", head: true })
    .eq("outcome_tracked", true)
    .eq("outcome_complete", false)
    .lt("observed_at", new Date(Date.now() - 60 * 60_000).toISOString());

  console.log(
    `[outcome-tracker] version=${VERSION} due=${stats.due} measured=${stats.measured} ` +
      `missed=${stats.missed} failed=${stats.failed} dexRequests=${stats.dexRequests} ` +
      `429=${stats.dex429} geckoFallback=${stats.geckoFallbacks} ` +
      `helius=${stats.heliusHits}/${stats.heliusRequests} heliusCache=${stats.heliusCacheHits} backlog=${backlog ?? 0}`
  );
}

async function cycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await promoteEnteredRows();
    await decideNewSamples();
    await trackDueOutcomes();
  } catch (error) {
    console.error("[outcome-tracker] cycle failed", error);
  } finally {
    running = false;
  }
}

export function startAiOutcomeTrackerV10(): void {
  console.log(
    `[outcome-tracker] ${VERSION} enabled sampleRate=${SAMPLE_RATE} batch=${BATCH_SIZE} cycleMs=${CYCLE_MS}`
  );
  void cycle();
  setInterval(() => void cycle(), CYCLE_MS);
}
