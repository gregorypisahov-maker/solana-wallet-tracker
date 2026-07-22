import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { config } from "./config";
import { applyEntryFriction } from "./executionFriction";
import { getPriceUsd, type PriceData } from "./priceFeed";

const supabase = getSupabaseAdmin();
const RECENT_WINDOW_MS = 15 * 60_000;
const MIN_ENTRY_WALLET_TRUST = 65;
const MARKET_DATA_RETRY_MS = 30_000;
const MAX_MARKET_DATA_RETRIES = 3;
const MAX_MARKET_DATA_AGE_MS = 90_000;
const ENTRY_CONFIRMATION_DELAY_MS = 8_000;
const MAX_CONFIRMATION_RISE_PCT = 5;
const MAX_CONFIRMATION_DROP_PCT = 2.5;
const MAX_CONFIRMATION_LIQUIDITY_DROP_PCT = 10;
let running = false;

type EntryConfirmation = {
  firstPriceUsd: number;
  firstLiquidityUsd: number;
  pairAddress: string;
  firstFetchedAt: string;
};

type RetryContext = {
  signalId: string;
  seenAt: string;
  attempt: number;
  confirmation?: EntryConfirmation;
};

const pendingWork = new Map<string, ReturnType<typeof setTimeout>>();

const n = (value: unknown, fallback = Number.NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const signalKey = (wallet: string, mint: string) => `${wallet}:${mint}`;
const positive = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

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

function scheduleWork(
  row: any,
  context: RetryContext,
  delayMs: number,
  description: string
): void {
  const key = signalKey(row.wallet_address, row.token_mint);
  const timer = setTimeout(() => {
    pendingWork.delete(key);
    void processRecentBuy(row, context);
  }, delayMs);
  pendingWork.set(key, timer);
  console.log(`[tiered-entry] ${description} scheduled for ${row.token_mint.slice(0, 6)}`);
}

function scheduleMarketRetry(row: any, context: RetryContext, missingFields: string[]): void {
  const nextContext = { ...context, attempt: context.attempt + 1 };
  scheduleWork(
    row,
    nextContext,
    MARKET_DATA_RETRY_MS,
    `market data retry ${nextContext.attempt}/${MAX_MARKET_DATA_RETRIES} missing=${missingFields.join(",")}`
  );
}

function scheduleEntryConfirmation(row: any, context: RetryContext, price: PriceData): void {
  scheduleWork(
    row,
    {
      ...context,
      confirmation: {
        firstPriceUsd: price.priceUsd,
        firstLiquidityUsd: Number(price.liquidityUsd),
        pairAddress: price.pairAddress,
        firstFetchedAt: price.fetchedAt,
      },
    },
    ENTRY_CONFIRMATION_DELAY_MS,
    "entry confirmation"
  );
}

function validatePriceSnapshot(price: PriceData, reasons: string[], prefix: string): void {
  const liquidity = positive(price.liquidityUsd);
  const marketCap = positive(price.marketCapUsd);

  if (!price.pairAddress) reasons.push(`${prefix}:missing_pair_address`);
  if (!Number.isFinite(price.priceUsd) || price.priceUsd <= 0) reasons.push(`${prefix}:invalid_price`);
  if (liquidity === null) reasons.push(`${prefix}:missing_liquidity`);
  else if (liquidity < config.entry.minLiquidityUsd) reasons.push(`${prefix}:liquidity_below_${config.entry.minLiquidityUsd}`);
  if (marketCap === null) reasons.push(`${prefix}:missing_market_cap`);
  else {
    if (marketCap < config.entry.minMarketCapUsd) reasons.push(`${prefix}:market_cap_below_${config.entry.minMarketCapUsd}`);
    if (marketCap > config.entry.maxMarketCapUsd) reasons.push(`${prefix}:market_cap_above_${config.entry.maxMarketCapUsd}`);
  }
  if (liquidity !== null && marketCap !== null && liquidity / marketCap < config.entry.minLiquidityToMcapRatio) {
    reasons.push(`${prefix}:liquidity_to_mcap_below_${config.entry.minLiquidityToMcapRatio}`);
  }
}

function validateConfirmation(
  first: EntryConfirmation,
  second: PriceData,
  reasons: string[],
  snapshot: Record<string, unknown>
): void {
  if (second.pairAddress !== first.pairAddress) reasons.push("confirmation_pair_changed");

  const priceChangePct = ((second.priceUsd / first.firstPriceUsd) - 1) * 100;
  const secondLiquidity = positive(second.liquidityUsd);
  const liquidityDropPct = secondLiquidity === null
    ? Number.POSITIVE_INFINITY
    : ((first.firstLiquidityUsd - secondLiquidity) / first.firstLiquidityUsd) * 100;

  snapshot.entry_confirmation = {
    first_price_usd: first.firstPriceUsd,
    second_price_usd: second.priceUsd,
    price_change_pct: priceChangePct,
    first_liquidity_usd: first.firstLiquidityUsd,
    second_liquidity_usd: secondLiquidity,
    liquidity_drop_pct: liquidityDropPct,
    first_pair_address: first.pairAddress,
    second_pair_address: second.pairAddress,
    first_fetched_at: first.firstFetchedAt,
    second_fetched_at: second.fetchedAt,
  };

  if (priceChangePct > MAX_CONFIRMATION_RISE_PCT) reasons.push("confirmation_price_still_spiking");
  if (priceChangePct < -MAX_CONFIRMATION_DROP_PCT) reasons.push("confirmation_price_not_holding");
  if (liquidityDropPct > MAX_CONFIRMATION_LIQUIDITY_DROP_PCT) reasons.push("confirmation_liquidity_dropped");
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
    strategy_version: "tiered_entry_shadow_v3_atomic_confirmed",
    source: "recent_signal_pump",
    transaction_id: row.id,
    wallet_address: row.wallet_address,
    token_mint: row.token_mint,
    tx_time: row.tx_time,
    sol_amount: n(row.sol_amount, 0),
    market_data_retry_attempt: context.attempt,
    market_data_retry_max: MAX_MARKET_DATA_RETRIES,
    confirmation_phase: context.confirmation ? "second_read" : "first_read",
  };

  const writeLog = async (entered: boolean) => {
    pendingWork.delete(key);
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
      pendingWork.delete(key);
      return;
    }

    const [walletR, trustR, scoreR, stateR] = await Promise.all([
      supabase.from("wallets").select("active,management_status").eq("address", row.wallet_address).maybeSingle(),
      supabase.from("wallet_performance").select("trust_score").eq("wallet_address", row.wallet_address).maybeSingle(),
      supabase.from("token_scores").select("score,token_symbol").eq("token_mint", row.token_mint).maybeSingle(),
      supabase.from("tiered_state").select("halted,halt_reason").eq("id", 1).single(),
    ]);
    const error = walletR.error ?? trustR.error ?? scoreR.error ?? stateR.error;
    if (error) {
      reasons.push(`lookup_error:${error.message}`);
      snapshot.lookup_error = error.message;
      await writeLog(false);
      return;
    }

    const wallet = walletR.data;
    const trust = trustR.data?.trust_score == null ? null : n(trustR.data.trust_score);
    const score = scoreR.data?.score == null ? null : n(scoreR.data.score);
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
    else if (trust < MIN_ENTRY_WALLET_TRUST) reasons.push("entry_wallet_trust_below_65");
    if (score !== null && score > 65) reasons.push("consensus_score_above_65");
    if (state.halted) reasons.push(`tiered_halted:${state.halt_reason ?? "unknown"}`);

    const market = await fetchTokenMarketData(row.token_mint);
    const marketCap = market.marketCap;
    const liquidity = market.liquidityUsd;
    snapshot.market = market;
    const missingFields: string[] = [];
    if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) missingFields.push("market_cap");
    else {
      if (marketCap < config.entry.minMarketCapUsd) reasons.push(`market_cap_below_${config.entry.minMarketCapUsd}`);
      if (marketCap > config.entry.maxMarketCapUsd) reasons.push(`market_cap_above_${config.entry.maxMarketCapUsd}`);
    }
    if (liquidity == null || !Number.isFinite(liquidity) || liquidity <= 0) missingFields.push("liquidity_usd");
    else if (liquidity < config.entry.minLiquidityUsd) reasons.push(`liquidity_below_${config.entry.minLiquidityUsd}`);
    if (marketCap != null && liquidity != null && Number.isFinite(marketCap) && marketCap > 0 && Number.isFinite(liquidity) && liquidity / marketCap < config.entry.minLiquidityToMcapRatio) {
      reasons.push(`liquidity_to_mcap_below_${config.entry.minLiquidityToMcapRatio}`);
    }

    const marketFetchedAt = market.fetchedAt ? Date.parse(market.fetchedAt) : Number.NaN;
    const marketAgeMs = Date.now() - marketFetchedAt;
    snapshot.market_data_age_ms = Number.isFinite(marketAgeMs) ? marketAgeMs : null;
    if (market.isStale) reasons.push("stale_market_data");
    if (!Number.isFinite(marketFetchedAt) || marketAgeMs > MAX_MARKET_DATA_AGE_MS) reasons.push("market_data_too_old");

    if (missingFields.length > 0 && reasons.length === 0) {
      snapshot.market_data_missing_fields = missingFields;
      if (context.attempt < MAX_MARKET_DATA_RETRIES) {
        scheduleMarketRetry(row, context, missingFields);
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
    snapshot.price_snapshot = price;
    validatePriceSnapshot(price, reasons, context.confirmation ? "second_price" : "first_price");
    if (reasons.length) {
      await writeLog(false);
      return;
    }

    if (!context.confirmation) {
      scheduleEntryConfirmation(row, context, price);
      return;
    }

    validateConfirmation(context.confirmation, price, reasons, snapshot);
    if (reasons.length) {
      await writeLog(false);
      return;
    }

    const entryPrice = applyEntryFriction(price.priceUsd, config.execution.entryFrictionPct);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      reasons.push("missing_data:entry_price");
      await writeLog(false);
      return;
    }

    const positionId = `tiered_${randomUUID()}`;
    snapshot.entry_price = entryPrice;
    snapshot.position_id = positionId;
    const entryAlert = {
      signalSource: "tiered_first_buy_confirmed",
      walletAddress: row.wallet_address,
      score,
      pairAddress: price.pairAddress,
      trustFloor: MIN_ENTRY_WALLET_TRUST,
    };

    const { data: openResult, error: openError } = await supabase.rpc("tiered_open_position", {
      p_mint: row.token_mint,
      p_token_symbol: market.symbol ?? scoreR.data?.token_symbol ?? "UNKNOWN",
      p_entry_price: entryPrice,
      p_entry_time: new Date().toISOString(),
      p_size_pct: config.position.sizePctPerTrade,
      p_entry_alert: entryAlert,
      p_position_id: positionId,
      p_entry_wallet: row.wallet_address,
      p_entry_wallet_trust: trust,
      p_filter_snapshot: snapshot,
    });
    if (openError) {
      reasons.push(`atomic_open_failed:${openError.message}`);
      await writeLog(false);
      return;
    }

    snapshot.atomic_open_result = openResult;
    if (!openResult?.opened) {
      reasons.push(`atomic_open_rejected:${openResult?.reason ?? "unknown"}`);
      await writeLog(false);
      return;
    }

    snapshot.position_size_sol = openResult.size_sol;
    await writeLog(true);
    console.log(
      `[tiered-entry] confirmed open ${market.symbol ?? row.token_mint.slice(0, 6)} ` +
      `trust ${trust} size ${Number(openResult.size_sol).toFixed(4)} SOL`
    );
  } catch (error) {
    pendingWork.delete(key);
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
      if (pendingWork.has(signalKey(row.wallet_address, row.token_mint))) continue;
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
  console.log("tiered recent signal pump v3 active: trust 65+, confirmed entries, atomic accounting");
  void tick();
  setInterval(() => void tick(), 2_000);
}
