import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import { expectedRoundTripCostPct } from "./liveCostSimulation";

const supabase = getSupabaseAdmin();
export const CHAMPION_PAPER_VERSION = "champion_paper_v1_2026_08_05";
const RESEARCH_VERSION = "champion_research_v1_2026_08_05";
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

const CONFIG = {
  positionSizeSol: envNumber("CHAMPION_PAPER_POSITION_SIZE_SOL", 0.2, 0.01, 10),
  maxConcurrent: Math.floor(envNumber("CHAMPION_PAPER_MAX_CONCURRENT", 3, 1, 20)),
  maxDailyEntries: Math.floor(envNumber("CHAMPION_PAPER_MAX_DAILY_ENTRIES", 15, 1, 200)),
  entryPollMs: envNumber("CHAMPION_PAPER_ENTRY_POLL_MS", 15_000, 5_000, 300_000),
  positionCheckMs: envNumber("CHAMPION_PAPER_POSITION_CHECK_MS", 5_000, 1_000, 60_000),
  targetPct: envNumber("CHAMPION_PAPER_TARGET_PCT", 10, 1, 100),
  hardStopPct: envNumber("CHAMPION_PAPER_HARD_STOP_PCT", 4, 0.5, 50),
  trailArmPct: envNumber("CHAMPION_PAPER_TRAIL_ARM_PCT", 6, 1, 100),
  trailGivebackPct: envNumber("CHAMPION_PAPER_TRAIL_GIVEBACK_PCT", 3, 0.5, 50),
  maxHoldSeconds: Math.floor(envNumber("CHAMPION_PAPER_MAX_HOLD_SECONDS", 1800, 60, 86_400)),
  minScore: envNumber("CHAMPION_PAPER_MIN_SCORE", 65, 0, 100),
  candidateMaxAgeSeconds: Math.floor(envNumber("CHAMPION_PAPER_CANDIDATE_MAX_AGE_SECONDS", 180, 30, 3600)),
  cooldownMinutes: Math.floor(envNumber("CHAMPION_PAPER_COOLDOWN_MINUTES", 180, 0, 10080)),
} as const;

let entryRunning = false;
let exitRunning = false;

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function pairFor(mint: string, pairAddress?: string | null) {
  const rows = await fetchJson(`${DEX_URL}/${encodeURIComponent(mint)}`);
  const pairs = Array.isArray(rows) ? rows : [];
  return pairs.find((pair: any) => pair?.pairAddress === pairAddress) ??
    pairs.filter((pair: any) => pair?.chainId === "solana" && pair?.baseToken?.address === mint)
      .sort((a: any, b: any) => n(b?.liquidity?.usd) - n(a?.liquidity?.usd))[0] ?? null;
}

async function state() {
  const { data, error } = await supabase.from("champion_paper_state").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
}

async function openPositions() {
  const { data, error } = await supabase.from("champion_paper_positions").select("*").order("opened_at");
  if (error) throw error;
  return data ?? [];
}

async function resetDaily(current: any): Promise<any> {
  const today = new Date().toISOString().slice(0, 10);
  if (String(current.daily_date) === today) return current;
  const { data, error } = await supabase.from("champion_paper_state").update({
    daily_date: today,
    entries_today: 0,
    updated_at: new Date().toISOString(),
  }).eq("id", 1).select("*").single();
  if (error) throw error;
  return data;
}

async function alreadyUsed(candidateId: string): Promise<boolean> {
  const [{ data: position }, { data: trade }] = await Promise.all([
    supabase.from("champion_paper_positions").select("position_id").eq("candidate_id", candidateId).limit(1),
    supabase.from("champion_paper_trades").select("id").eq("candidate_id", candidateId).limit(1),
  ]);
  return Boolean(position?.length || trade?.length);
}

async function recentlyTraded(mint: string): Promise<boolean> {
  if (CONFIG.cooldownMinutes <= 0) return false;
  const cutoff = new Date(Date.now() - CONFIG.cooldownMinutes * 60_000).toISOString();
  const { data, error } = await supabase.from("champion_paper_trades")
    .select("id").eq("mint", mint).gte("closed_at", cutoff).limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

async function nextCandidates(limit: number) {
  const cutoff = new Date(Date.now() - CONFIG.candidateMaxAgeSeconds * 1000).toISOString();
  const { data, error } = await supabase.from("champion_candidates")
    .select("*")
    .eq("strategy_version", RESEARCH_VERSION)
    .eq("decision", "accepted_research")
    .gte("score", CONFIG.minScore)
    .gte("detected_at", cutoff)
    .order("score", { ascending: false })
    .order("detected_at", { ascending: false })
    .limit(Math.max(10, limit * 5));
  if (error) throw error;
  return data ?? [];
}

async function telegram(message: string): Promise<void> {
  try { await sendTelegramAlert(message, { forceOperational: true }); }
  catch (error) { console.warn("[champion-paper] Telegram failed", error); }
}

async function openOne(candidate: any, currentState: any): Promise<boolean> {
  if (await alreadyUsed(candidate.candidate_id)) return false;
  if (await recentlyTraded(candidate.mint)) return false;
  const pair = await pairFor(candidate.mint, candidate.pair_address);
  const price = n(pair?.priceUsd);
  const liquidity = n(pair?.liquidity?.usd);
  if (price <= 0 || liquidity < 100_000) return false;

  const positionId = randomUUID();
  const now = new Date().toISOString();
  const costPct = expectedRoundTripCostPct(CONFIG.positionSizeSol);
  const entrySnapshot = {
    candidate_id: candidate.candidate_id,
    strategy_version: CHAMPION_PAPER_VERSION,
    research_version: RESEARCH_VERSION,
    score: n(candidate.score),
    decision_reasons: candidate.decision_reasons,
    features: candidate.features,
    modeled_round_trip_cost_pct: costPct,
    paper_only: true,
  };

  const { error: positionError } = await supabase.from("champion_paper_positions").insert({
    position_id: positionId,
    candidate_id: candidate.candidate_id,
    strategy_version: CHAMPION_PAPER_VERSION,
    mint: candidate.mint,
    token_symbol: candidate.token_symbol,
    pair_address: candidate.pair_address,
    entry_price_usd: price,
    size_sol: CONFIG.positionSizeSol,
    peak_price_usd: price,
    last_price_usd: price,
    opened_at: now,
    last_checked_at: now,
    entry_snapshot: entrySnapshot,
  });
  if (positionError) {
    if (/duplicate|unique/i.test(positionError.message)) return false;
    throw positionError;
  }

  const { error: stateError } = await supabase.from("champion_paper_state").update({
    bankroll_sol: n(currentState.bankroll_sol) - CONFIG.positionSizeSol,
    entries_today: n(currentState.entries_today) + 1,
    last_entry_at: now,
    updated_at: now,
    config: CONFIG,
  }).eq("id", 1);
  if (stateError) throw stateError;

  await telegram(
    `🏆 <b>CHAMPION PAPER BUY</b>\n\n` +
    `🪙 <b>${candidate.token_symbol ?? "UNKNOWN"}</b>\n` +
    `Size: <b>${CONFIG.positionSizeSol.toFixed(3)} SOL</b>\n` +
    `Score: <b>${n(candidate.score).toFixed(0)}/100</b>\n` +
    `Entry: <b>$${price.toFixed(8)}</b>\n` +
    `Liquidity: <b>$${liquidity.toFixed(0)}</b>\n` +
    `Target: <b>+${CONFIG.targetPct}%</b> · Stop: <b>-${CONFIG.hardStopPct}%</b>\n` +
    `Strategy: <b>${CHAMPION_PAPER_VERSION}</b>\n\n` +
    `<code>${candidate.mint}</code>`
  );
  console.log(`[champion-paper] OPEN ${candidate.token_symbol} score=${n(candidate.score)} size=${CONFIG.positionSizeSol}`);
  return true;
}

async function pollEntries(): Promise<void> {
  if (entryRunning) return;
  entryRunning = true;
  try {
    let current = await resetDaily(await state());
    if (!current.enabled || !current.paper_only || current.halted) return;
    const positions = await openPositions();
    let slots = Math.max(0, CONFIG.maxConcurrent - positions.length);
    let dailySlots = Math.max(0, CONFIG.maxDailyEntries - n(current.entries_today));
    if (slots <= 0 || dailySlots <= 0 || n(current.bankroll_sol) < CONFIG.positionSizeSol) return;

    const candidates = await nextCandidates(Math.min(slots, dailySlots));
    for (const candidate of candidates) {
      if (slots <= 0 || dailySlots <= 0 || n(current.bankroll_sol) < CONFIG.positionSizeSol) break;
      if (await openOne(candidate, current)) {
        slots -= 1;
        dailySlots -= 1;
        current = { ...current, bankroll_sol: n(current.bankroll_sol) - CONFIG.positionSizeSol, entries_today: n(current.entries_today) + 1 };
      }
    }
  } finally {
    entryRunning = false;
  }
}

function exitReason(grossPct: number, peakGrossPct: number, ageSeconds: number): string | null {
  if (grossPct <= -CONFIG.hardStopPct) return "hard_stop";
  if (peakGrossPct >= CONFIG.trailArmPct && grossPct <= peakGrossPct - CONFIG.trailGivebackPct) return "trailing_stop";
  if (grossPct >= CONFIG.targetPct) return "take_profit";
  if (ageSeconds >= CONFIG.maxHoldSeconds) return "max_hold_time";
  return null;
}

async function closePosition(position: any, price: number, peak: number, reason: string): Promise<void> {
  const size = n(position.size_sol);
  const grossPct = (price / n(position.entry_price_usd) - 1) * 100;
  const costPct = expectedRoundTripCostPct(size);
  const netPct = grossPct - costPct;
  const proceeds = Math.max(0, size * (1 + netPct / 100));
  const pnl = proceeds - size;
  const now = new Date().toISOString();
  const current = await state();

  const { error: tradeError } = await supabase.from("champion_paper_trades").insert({
    position_id: position.position_id,
    candidate_id: position.candidate_id,
    strategy_version: CHAMPION_PAPER_VERSION,
    mint: position.mint,
    token_symbol: position.token_symbol,
    pair_address: position.pair_address,
    entry_price_usd: position.entry_price_usd,
    exit_price_usd: price,
    size_sol: size,
    gross_return_pct: grossPct,
    net_return_pct: netPct,
    pnl_sol: pnl,
    proceeds_sol: proceeds,
    exit_reason: reason,
    opened_at: position.opened_at,
    closed_at: now,
    entry_snapshot: position.entry_snapshot,
    exit_snapshot: {
      peak_price_usd: peak,
      peak_gross_return_pct: (peak / n(position.entry_price_usd) - 1) * 100,
      modeled_round_trip_cost_pct: costPct,
      paper_only: true,
    },
  });
  if (tradeError) throw tradeError;

  const { error: deleteError } = await supabase.from("champion_paper_positions").delete().eq("position_id", position.position_id);
  if (deleteError) throw deleteError;
  const { error: stateError } = await supabase.from("champion_paper_state").update({
    bankroll_sol: n(current.bankroll_sol) + proceeds,
    last_check_at: now,
    updated_at: now,
  }).eq("id", 1);
  if (stateError) throw stateError;

  await telegram(
    `${pnl >= 0 ? "🏆" : "🔴"} <b>CHAMPION PAPER SELL</b>\n\n` +
    `🪙 <b>${position.token_symbol ?? "UNKNOWN"}</b>\n` +
    `Reason: <b>${reason.replaceAll("_", " ")}</b>\n` +
    `Gross: <b>${grossPct.toFixed(2)}%</b>\n` +
    `Net: <b>${netPct.toFixed(2)}%</b>\n` +
    `Paper PnL: <b>${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} SOL</b>\n` +
    `Strategy: <b>${CHAMPION_PAPER_VERSION}</b>`
  );
  console.log(`[champion-paper] CLOSE ${position.token_symbol} ${reason} net=${netPct.toFixed(2)}%`);
}

async function checkPositions(): Promise<void> {
  if (exitRunning) return;
  exitRunning = true;
  try {
    const current = await state();
    if (!current.enabled || !current.paper_only) return;
    for (const position of await openPositions()) {
      try {
        const pair = await pairFor(position.mint, position.pair_address);
        const price = n(pair?.priceUsd);
        if (price <= 0) continue;
        const entry = n(position.entry_price_usd);
        const peak = Math.max(n(position.peak_price_usd, entry), price);
        const grossPct = (price / entry - 1) * 100;
        const peakGrossPct = (peak / entry - 1) * 100;
        const ageSeconds = Math.max(0, Date.now() - Date.parse(position.opened_at)) / 1000;
        const reason = exitReason(grossPct, peakGrossPct, ageSeconds);
        if (reason) await closePosition(position, price, peak, reason);
        else {
          const now = new Date().toISOString();
          await supabase.from("champion_paper_positions").update({
            peak_price_usd: peak,
            last_price_usd: price,
            last_checked_at: now,
          }).eq("position_id", position.position_id);
          await supabase.from("champion_paper_state").update({ last_check_at: now, updated_at: now }).eq("id", 1);
        }
      } catch (error) {
        console.warn(`[champion-paper] position check failed ${position.mint}`, error);
      }
    }
  } finally {
    exitRunning = false;
  }
}

export function startChampionPaperScheduler(): void {
  const costPct = expectedRoundTripCostPct(CONFIG.positionSizeSol);
  if (!(costPct < CONFIG.hardStopPct)) {
    throw new Error(`champion modeled cost ${costPct.toFixed(3)}% must be below stop ${CONFIG.hardStopPct}%`);
  }
  console.log(
    `[champion-paper-config] version=${CHAMPION_PAPER_VERSION} size=${CONFIG.positionSizeSol} ` +
    `target=${CONFIG.targetPct}% stop=${CONFIG.hardStopPct}% trail=${CONFIG.trailArmPct}/${CONFIG.trailGivebackPct}% ` +
    `maxHold=${CONFIG.maxHoldSeconds}s concurrent=${CONFIG.maxConcurrent} daily=${CONFIG.maxDailyEntries} ` +
    `minScore=${CONFIG.minScore} modeledCost=${costPct.toFixed(3)}% paperOnly=true`
  );
  void pollEntries().catch((error) => console.error("[champion-paper] initial entry poll failed", error));
  void checkPositions().catch((error) => console.error("[champion-paper] initial position check failed", error));
  setInterval(() => void pollEntries().catch((error) => console.error("[champion-paper] entry poll failed", error)), CONFIG.entryPollMs);
  setInterval(() => void checkPositions().catch((error) => console.error("[champion-paper] position check failed", error)), CONFIG.positionCheckMs);
}
