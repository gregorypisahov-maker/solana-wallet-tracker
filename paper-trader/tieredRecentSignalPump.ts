import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { config } from "./config";
import { applyEntryFriction } from "./executionFriction";
import { getPriceUsd } from "./priceFeed";

const supabase = getSupabaseAdmin();
const RECENT_WINDOW_MS = 15 * 60_000;
const COOLDOWN_MS = 4 * 60 * 60_000;
const MAX_POSITIONS = 3;
const MIN_ENTRY_WALLET_TRUST = 55;
const MARKET_DATA_RETRY_MS = 30_000;
const MAX_MARKET_DATA_RETRIES = 3;
let running = false;

type RetryContext = {
  signalId: string;
  seenAt: string;
  attempt: number;
};

const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();

const n = (value: unknown, fallback = Number.NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const signalKey = (wallet: string, mint: string) => `${wallet}:${mint}`;

async function alreadyProcessed(wallet: string, mint: string): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("tiered_processed_signals")
    .select("id")
    .eq("wallet_address", wallet)
    .eq("token_mint", mint)
    .limit(1);
  if (error) {
    console.error("[tiered-entry] processed lookup failed; fail-closed:", error);
    return null;
  }
  return Boolean(data?.length);
}

function scheduleRetry(row: any, context: RetryContext, missingFields: string[]): void {
  const key = signalKey(row.wallet_address, row.token_mint);
  const nextAttempt = context.attempt + 1;
  const timer = setTimeout(() => {
    pendingRetries.delete(key);
    void processRecentBuy(row, { ...context, attempt: nextAttempt });
  }, MARKET_DATA_RETRY_MS);
  pendingRetries.set(key, timer);
  console.log(
    `[tiered-entry] market data retry ${nextAttempt}/${MAX_MARKET_DATA_RETRIES} scheduled ` +
      `for ${row.token_mint.slice(0, 6)} missing=${missingFields.join(",")}`
  );
}

async function processRecentBuy(
  row: any,
  context: RetryContext = {
    signalId: randomUUID(),
    seenAt: new Date().toISOString(),
    attempt: 0,
  }
): Promise<void> {
  const key = signalKey(row.wallet_address, row.token_mint);
  const reasons: string[] = [];
  const snapshot: Record<string, unknown> = {
    strategy_version: "tiered_entry_shadow_v2",
    source: "recent_signal_pump",
    transaction_id: row.id,
    wallet_address: row.wallet_address,
    token_mint: row.token_mint,
    tx_time: row.tx_time,
    sol_amount: n(row.sol_amount, 0),
    market_data_retry_attempt: context.attempt,
    market_data_retry_max: MAX_MARKET_DATA_RETRIES,
  };

  const writeLog = async (entered: boolean) => {
    pendingRetries.delete(key);
    const { error } = await supabase.from("tiered_processed_signals").insert({
      id: context.signalId,
      wallet_address: row.wallet_address,
      token_mint: row.token_mint,
      seen_at: context.seenAt,
      entered,
      skip_reasons: reasons,
      filter_snapshot: snapshot,
    });
    if (error && error.code !== "23505") throw new Error(`tiered signal log failed: ${error.message}`);
  };

  try {
    const processed = await alreadyProcessed(row.wallet_address, row.token_mint);
    if (processed === null || processed) {
      pendingRetries.delete(key);
      return;
    }

    const [walletR, trustR, scoreR, stateR, positionsR, cooldownR] = await Promise.all([
      supabase.from("wallets").select("active,management_status").eq("address", row.wallet_address).maybeSingle(),
      supabase.from("wallet_performance").select("trust_score").eq("wallet_address", row.wallet_address).maybeSingle(),
      supabase.from("token_scores").select("score,token_symbol").eq("token_mint", row.token_mint).maybeSingle(),
      supabase.from("tiered_state").select("*").eq("id", 1).single(),
      supabase.from("tiered_positions").select("mint"),
      supabase.from("tiered_trades").select("id").eq("mint", row.token_mint).gte("happened_at", new Date(Date.now() - COOLDOWN_MS).toISOString()).limit(1),
    ]);
    const error = walletR.error ?? trustR.error ?? scoreR.error ?? stateR.error ?? positionsR.error ?? cooldownR.error;
    if (error) {
      reasons.push(`lookup_error:${error.message}`);
      snapshot.lookup_error = error.message;
      await writeLog(false);
      return;
    }

    const wallet = walletR.data;
    const trust = trustR.data?.trust_score == null ? null : n(trustR.data.trust_score);
    const score = scoreR.data?.score == null ? null : n(scoreR.data.score);
    const positions = positionsR.data ?? [];
    const state = stateR.data;
    snapshot.wallet = wallet;
    snapshot.entry_wallet_trust = trust;
    snapshot.current_score = score;
    snapshot.score_status = score === null ? "score_not_yet_formed" : "score_present";

    if (!wallet) reasons.push("missing_data:wallet");
    else {
      if (wallet.active !== true) reasons.push("wallet_not_active");
      if (wallet.management_status !== "proven") reasons.push("wallet_not_proven");
    }
    if (trust === null || !Number.isFinite(trust)) reasons.push("missing_data:entry_wallet_trust");
    else if (trust < MIN_ENTRY_WALLET_TRUST) reasons.push("entry_wallet_trust_below_55");
    if (score !== null && score > 65) reasons.push("consensus_score_above_65");
    if (state.halted) reasons.push(`tiered_halted:${state.halt_reason ?? "unknown"}`);
    if (positions.length >= MAX_POSITIONS) reasons.push("max_concurrent_positions");
    if (positions.some((position: any) => position.mint === row.token_mint)) reasons.push("mint_already_open");
    if ((cooldownR.data ?? []).length) reasons.push("mint_in_4h_cooldown");

    const market = await fetchTokenMarketData(row.token_mint);
    const marketCap = market.marketCap;
    const liquidity = market.liquidityUsd;
    snapshot.market = market;
    const missingFields: string[] = [];
    if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) missingFields.push("market_cap");
    else if (marketCap > 200_000) reasons.push("market_cap_above_200000");
    if (liquidity == null || !Number.isFinite(liquidity)) missingFields.push("liquidity_usd");
    if (marketCap != null && liquidity != null && Number.isFinite(marketCap) && marketCap > 0 && Number.isFinite(liquidity) && liquidity / marketCap < 0.15) {
      reasons.push("liquidity_to_mcap_below_0.15");
    }

    if (missingFields.length > 0 && reasons.length === 0) {
      snapshot.market_data_missing_fields = missingFields;
      if (context.attempt < MAX_MARKET_DATA_RETRIES) {
        scheduleRetry(row, context, missingFields);
        return;
      }
      reasons.push(...missingFields.map((field) => `missing_data_after_retry:${field}`));
    } else if (missingFields.length > 0) {
      reasons.push(...missingFields.map((field) => `missing_data:${field}`));
    }

    const [mainPositionR, mainTradeR] = await Promise.all([
      supabase.from("paper_positions").select("entry_time").eq("mint", row.token_mint).order("entry_time", { ascending: true }).limit(1).maybeSingle(),
      supabase.from("paper_trades").select("happened_at").eq("mint", row.token_mint).order("happened_at", { ascending: true }).limit(1).maybeSingle(),
    ]);
    const mainTime = mainPositionR.data?.entry_time ?? mainTradeR.data?.happened_at ?? null;
    snapshot.main_entered = Boolean(mainPositionR.data || mainTradeR.data);
    snapshot.minutes_between_tiered_and_main = mainTime ? (Date.parse(mainTime) - Date.now()) / 60_000 : null;

    if (reasons.length) {
      await writeLog(false);
      return;
    }

    const price = await getPriceUsd(row.token_mint);
    const entryPrice = applyEntryFriction(price.priceUsd, config.execution.entryFrictionPct);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      reasons.push("missing_data:entry_price");
      await writeLog(false);
      return;
    }

    const bankroll = n(state.bankroll_sol, 0);
    const sizeSol = bankroll * config.position.sizePctPerTrade;
    if (!Number.isFinite(sizeSol) || sizeSol <= 0 || sizeSol > bankroll) {
      reasons.push("invalid_position_size");
      await writeLog(false);
      return;
    }

    const positionId = `tiered_${randomUUID()}`;
    snapshot.entry_price = entryPrice;
    snapshot.position_size_sol = sizeSol;
    const { error: openError } = await supabase.from("tiered_positions").insert({
      mint: row.token_mint,
      token_symbol: market.symbol ?? scoreR.data?.token_symbol ?? "UNKNOWN",
      entry_price: entryPrice,
      entry_time: new Date().toISOString(),
      size_sol: sizeSol,
      remaining_pct: 1,
      peak_multiple: 1,
      ladder_hits: [],
      entry_alert: { signalSource: "tiered_first_buy", walletAddress: row.wallet_address, score },
      position_id: positionId,
      realized_pnl_sol: 0,
      entry_wallet: row.wallet_address,
      entry_wallet_trust: trust,
      filter_snapshot: snapshot,
    });
    if (openError) {
      reasons.push(`position_open_failed:${openError.message}`);
      await writeLog(false);
      return;
    }

    const { error: stateError } = await supabase.from("tiered_state").update({
      bankroll_sol: bankroll - sizeSol,
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    if (stateError) {
      await supabase.from("tiered_positions").delete().eq("position_id", positionId);
      reasons.push(`bankroll_update_failed:${stateError.message}`);
      await writeLog(false);
      return;
    }

    await writeLog(true);
    console.log(`[tiered-entry] immediate open ${market.symbol ?? row.token_mint.slice(0, 6)} trust ${trust}`);
  } catch (error) {
    pendingRetries.delete(key);
    const message = error instanceof Error ? error.message : String(error);
    reasons.push(`evaluation_error:${message}`);
    snapshot.evaluation_error = message;
    try { await writeLog(false); } catch (logError) { console.error("[tiered-entry] failed to log isolated error:", logError); }
    console.error("[tiered-entry] recent signal isolated failure:", error);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { data, error } = await supabase
      .from("wallet_transactions")
      .select("id,wallet_address,token_mint,sol_amount,tx_time")
      .eq("side", "buy")
      .gte("tx_time", new Date(Date.now() - RECENT_WINDOW_MS).toISOString())
      .order("tx_time", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    for (const row of [...(data ?? [])].reverse()) {
      if (pendingRetries.has(signalKey(row.wallet_address, row.token_mint))) continue;
      const processed = await alreadyProcessed(row.wallet_address, row.token_mint);
      if (processed === null || processed) continue;
      await processRecentBuy(row);
    }
  } catch (error) {
    console.error("[tiered-entry] recent pump isolated failure:", error);
  } finally {
    running = false;
  }
}

export function startTieredRecentSignalPump(): void {
  void tick();
  setInterval(() => void tick(), 2_000);
}
