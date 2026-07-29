import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const VERSION = "ai_outcome_tracker_v10_2026_07_29";
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const SAMPLE_RATE = Math.min(1, Math.max(0, Number(process.env.AI_OUTCOME_SAMPLE_RATE) || 0.1));
const BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.AI_OUTCOME_BATCH_SIZE) || 25));
const HORIZONS = [5, 15, 30, 45] as const;
const TOLERANCE_MS: Record<(typeof HORIZONS)[number], number> = {
  5: 90_000,
  15: 120_000,
  30: 180_000,
  45: 180_000,
};

let running = false;

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function pairPrice(mint: string, pairAddress: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${DEX_URL}/${encodeURIComponent(mint)}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const body = await response.json();
    const pairs = Array.isArray(body) ? body : [];
    const pair = pairs.find(
      (item: any) =>
        item?.chainId === "solana" &&
        String(item?.pairAddress ?? "") === pairAddress &&
        item?.baseToken?.address === mint
    );
    const price = n(pair?.priceUsd, Number.NaN);
    return Number.isFinite(price) && price > 0 ? price : null;
  } finally {
    clearTimeout(timer);
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
    .limit(100);
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

    const now = new Date().toISOString();
    let price = forced ? n(row.entry_price_usd, 0) : 0;
    if (price <= 0 && row.pair_address) {
      price = n(await pairPrice(row.mint, row.pair_address).catch(() => null), 0);
    }
    await supabase
      .from("ai_candidate_observations")
      .update({
        outcome_tracked: price > 0,
        outcome_sample_source: forced ? "entered_trade" : "random",
        observed_price_usd: price > 0 ? price : null,
        observed_price_at: price > 0 ? now : null,
        outcome_quality: price > 0 ? null : "missing_baseline",
        outcome_complete: price <= 0,
        updated_at: now,
      })
      .eq("id", row.id);
  }
}

async function promoteEnteredRows(): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("ai_candidate_observations")
    .select("id,entry_price_usd")
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
        observed_price_at: now,
        outcome_quality: null,
        outcome_complete: false,
        updated_at: now,
      })
      .eq("id", row.id);
  }
}

async function trackDueOutcomes(): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
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
      const observedMs = Date.parse(row.observed_at);
      const misses = Array.isArray(row.horizon_misses) ? row.horizon_misses : [];
      const horizon = HORIZONS.find(
        (minutes) => row[`price_${minutes}m_usd`] == null && !misses.includes(`${minutes}m`)
      );
      if (!horizon || !Number.isFinite(observedMs)) return null;
      const targetMs = observedMs + horizon * 60_000;
      if (nowMs < targetMs - TOLERANCE_MS[horizon]) return null;
      return { row, horizon, targetMs };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.targetMs - b.targetMs)
    .slice(0, BATCH_SIZE) as Array<any>;

  const prices = new Map<string, number | null>();
  let measured = 0;
  let missed = 0;
  let rateLimited = 0;

  for (const item of actionable) {
    const { row, horizon, targetMs } = item;
    const now = new Date().toISOString();
    const misses = Array.isArray(row.horizon_misses) ? [...row.horizon_misses] : [];
    const updates: Record<string, unknown> = {
      updated_at: now,
      last_outcome_attempt_at: now,
      outcome_fetch_attempts: n(row.outcome_fetch_attempts) + 1,
    };

    if (Date.now() > targetMs + TOLERANCE_MS[horizon]) {
      const label = `${horizon}m`;
      if (!misses.includes(label)) misses.push(label);
      updates.horizon_misses = misses;
      missed += 1;
    } else {
      const key = `${row.mint}:${row.pair_address}`;
      let price = prices.get(key);
      if (price === undefined) {
        try {
          price = await pairPrice(row.mint, row.pair_address);
        } catch (fetchError) {
          const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
          if (/429/.test(message)) rateLimited += 1;
          updates.last_outcome_error = message.slice(0, 500);
          price = null;
        }
        prices.set(key, price);
      }
      if (price && price > 0) {
        const base = n(row.observed_price_usd, 0);
        updates[`price_${horizon}m_usd`] = price;
        updates[`price_${horizon}m_at`] = now;
        updates[`return_${horizon}m_pct`] =
          base > 0 ? Number((((price / base) - 1) * 100).toFixed(4)) : null;
        updates.last_outcome_error = null;
        measured += 1;
      }
    }

    const resolved = HORIZONS.map((minutes) => {
      const measuredNow = minutes === horizon && updates[`price_${minutes}m_usd`] != null;
      const missedNow = minutes === horizon && (updates.horizon_misses as string[] | undefined)?.includes(`${minutes}m`);
      return measuredNow || missedNow || row[`price_${minutes}m_usd`] != null || misses.includes(`${minutes}m`);
    });
    if (resolved.every(Boolean) || Date.now() > Date.parse(row.observed_at) + 48 * 60_000) {
      const measuredCount = HORIZONS.filter((minutes) =>
        minutes === horizon ? updates[`price_${minutes}m_usd`] != null : row[`price_${minutes}m_usd`] != null
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
    `[outcome-tracker] version=${VERSION} due=${actionable.length} measured=${measured} ` +
      `missed=${missed} pairsFetched=${prices.size} 429=${rateLimited} backlog=${backlog ?? 0}`
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
  console.log(`[outcome-tracker] ${VERSION} enabled sampleRate=${SAMPLE_RATE} batch=${BATCH_SIZE}`);
  void cycle();
  setInterval(() => void cycle(), 60_000);
}
