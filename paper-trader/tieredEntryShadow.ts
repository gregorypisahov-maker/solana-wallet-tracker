import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { config } from "./config";
import { applyEntryFriction, applyExitFriction } from "./executionFriction";
import { getPriceUsd } from "./priceFeed";
import { evaluateSharedPaperExit } from "./sharedPaperExit";

const supabase = getSupabaseAdmin();
const EVALUATION_INTERVAL_MS = 2_000;
const POSITION_INTERVAL_MS = config.polling.intervalMs;
const MAX_POSITIONS = 3;
const COOLDOWN_MS = 4 * 60 * 60_000;
const SUSPECT_DROP_PCT = 90;
const SUSPECT_CONFIRMATION_MS = 10_000;
const VERSION = "tiered_entry_shadow_v1";

let evaluating = false;
let checking = false;
let operationTail: Promise<void> = Promise.resolve();
const suspectPrices = new Map<string, { firstSeenAt: number; price: number }>();

function numberValue(value: unknown, fallback = Number.NaN): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
  const previous = operationTail;
  let release!: () => void;
  operationTail = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(operation).finally(release);
}

async function logSignal(input: {
  id: string;
  walletAddress: string;
  tokenMint: string;
  seenAt: string;
  entered: boolean;
  skipReasons: string[];
  snapshot: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("tiered_processed_signals").insert({
    id: input.id,
    wallet_address: input.walletAddress,
    token_mint: input.tokenMint,
    seen_at: input.seenAt,
    entered: input.entered,
    skip_reasons: input.skipReasons,
    filter_snapshot: input.snapshot,
  });
  if (error) throw new Error(`tiered signal log failed: ${error.message}`);
}

async function evaluateSignal(row: any): Promise<void> {
  const id = randomUUID();
  const seenAt = new Date().toISOString();
  const skipReasons: string[] = [];
  const snapshot: Record<string, unknown> = {
    strategy_version: VERSION,
    transaction_id: row.id,
    signature: row.signature,
    wallet_address: row.wallet_address,
    token_mint: row.token_mint,
    tx_time: row.tx_time,
    sol_amount: numberValue(row.sol_amount, 0),
  };

  try {
    const [walletResult, performanceResult, scoreResult, stateResult, positionsResult, cooldownResult] = await Promise.all([
      supabase.from("wallets").select("active,management_status").eq("address", row.wallet_address).maybeSingle(),
      supabase.from("wallet_performance").select("trust_score").eq("wallet_address", row.wallet_address).maybeSingle(),
      supabase.from("token_scores").select("score,token_symbol,market_cap,liquidity_usd,updated_at").eq("token_mint", row.token_mint).maybeSingle(),
      supabase.from("tiered_state").select("*").eq("id", 1).single(),
      supabase.from("tiered_positions").select("mint,position_id"),
      supabase.from("tiered_trades").select("id").eq("mint", row.token_mint).gte("happened_at", new Date(Date.now() - COOLDOWN_MS).toISOString()).limit(1),
    ]);

    const lookupError = walletResult.error ?? performanceResult.error ?? scoreResult.error ?? stateResult.error ?? positionsResult.error ?? cooldownResult.error;
    if (lookupError) {
      skipReasons.push(`lookup_error:${lookupError.message}`);
      snapshot.lookup_error = lookupError.message;
      await logSignal({ id, walletAddress: row.wallet_address, tokenMint: row.token_mint, seenAt, entered: false, skipReasons, snapshot });
      return;
    }

    const wallet = walletResult.data;
    const trust = performanceResult.data?.trust_score === null || performanceResult.data?.trust_score === undefined
      ? null
      : numberValue(performanceResult.data.trust_score);
    const scoreRow = scoreResult.data;
    const state = stateResult.data;
    const positions = positionsResult.data ?? [];

    snapshot.wallet = wallet;
    snapshot.entry_wallet_trust = trust;
    snapshot.current_score = scoreRow?.score ?? null;
    snapshot.score_status = scoreRow?.score === null || scoreRow?.score === undefined ? "score_not_yet_formed" : "score_present";

    if (!wallet) skipReasons.push("missing_data:wallet");
    if (wallet && wallet.active !== true) skipReasons.push("wallet_not_active");
    if (wallet && wallet.management_status !== "proven") skipReasons.push("wallet_not_proven");
    if (trust === null || !Number.isFinite(trust)) skipReasons.push("missing_data:entry_wallet_trust");
    else if (trust < 65) skipReasons.push("entry_wallet_trust_below_65");
    if (state.halted) skipReasons.push(`tiered_halted:${state.halt_reason ?? "unknown"}`);
    if (positions.length >= MAX_POSITIONS) skipReasons.push("max_concurrent_positions");
    if (positions.some((position: any) => position.mint === row.token_mint)) skipReasons.push("mint_already_open");
    if ((cooldownResult.data ?? []).length > 0) skipReasons.push("mint_in_4h_cooldown");

    const market = await fetchTokenMarketData(row.token_mint);
    snapshot.market = market;

    const marketCap = market.marketCap;
    const liquidity = market.liquidityUsd;
    if (marketCap === null || !Number.isFinite(marketCap)) skipReasons.push("missing_data:market_cap");
    if (liquidity === null || !Number.isFinite(liquidity)) skipReasons.push("missing_data:liquidity_usd");
    if (marketCap !== null && Number.isFinite(marketCap) && marketCap > 200_000) skipReasons.push("market_cap_above_200000");
    if (
      marketCap !== null && liquidity !== null && Number.isFinite(marketCap) && Number.isFinite(liquidity) &&
      marketCap > 0 && liquidity / marketCap < 0.15
    ) skipReasons.push("liquidity_to_mcap_below_0.15");
    if (marketCap !== null && marketCap <= 0) skipReasons.push("missing_data:market_cap");

    if (scoreRow?.score !== null && scoreRow?.score !== undefined && numberValue(scoreRow.score) > 65) {
      skipReasons.push("consensus_score_above_65");
    }

    const [mainPositionResult, mainTradeResult] = await Promise.all([
      supabase.from("paper_positions").select("entry_time").eq("mint", row.token_mint).order("entry_time", { ascending: true }).limit(1).maybeSingle(),
      supabase.from("paper_trades").select("happened_at,entry_alert").eq("mint", row.token_mint).order("happened_at", { ascending: true }).limit(1).maybeSingle(),
    ]);
    const mainTime = mainPositionResult.data?.entry_time ?? mainTradeResult.data?.entry_alert?.timestamp ?? mainTradeResult.data?.happened_at ?? null;
    snapshot.main_entered = Boolean(mainPositionResult.data || mainTradeResult.data);
    snapshot.minutes_between_tiered_and_main = mainTime ? (Date.parse(mainTime) - Date.now()) / 60_000 : null;

    if (skipReasons.length > 0) {
      await logSignal({ id, walletAddress: row.wallet_address, tokenMint: row.token_mint, seenAt, entered: false, skipReasons, snapshot });
      return;
    }

    const rawPrice = await getPriceUsd(row.token_mint);
    const entryPrice = applyEntryFriction(rawPrice.priceUsd, config.execution.entryFrictionPct);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      skipReasons.push("missing_data:entry_price");
      snapshot.entry_price_error = rawPrice;
      await logSignal({ id, walletAddress: row.wallet_address, tokenMint: row.token_mint, seenAt, entered: false, skipReasons, snapshot });
      return;
    }

    const bankroll = numberValue(state.bankroll_sol, 0);
    const sizeSol = bankroll * config.position.sizePctPerTrade;
    if (!Number.isFinite(sizeSol) || sizeSol <= 0 || sizeSol > bankroll) {
      skipReasons.push("invalid_position_size");
      snapshot.calculated_size_sol = sizeSol;
      await logSignal({ id, walletAddress: row.wallet_address, tokenMint: row.token_mint, seenAt, entered: false, skipReasons, snapshot });
      return;
    }

    const entryTime = new Date().toISOString();
    const positionId = `tiered_${randomUUID()}`;
    snapshot.entry_price = entryPrice;
    snapshot.position_size_sol = sizeSol;

    const { error: positionError } = await supabase.from("tiered_positions").insert({
      mint: row.token_mint,
      token_symbol: market.symbol ?? scoreRow?.token_symbol ?? "UNKNOWN",
      entry_price: entryPrice,
      entry_time: entryTime,
      size_sol: sizeSol,
      remaining_pct: 1,
      peak_multiple: 1,
      ladder_hits: [],
      entry_alert: { signalSource: "tiered_first_buy", walletAddress: row.wallet_address, score: scoreRow?.score ?? null },
      position_id: positionId,
      realized_pnl_sol: 0,
      entry_wallet: row.wallet_address,
      entry_wallet_trust: trust,
      filter_snapshot: snapshot,
    });
    if (positionError) throw new Error(`tiered position insert failed: ${positionError.message}`);

    const { error: stateError } = await supabase.from("tiered_state").update({
      bankroll_sol: bankroll - sizeSol,
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    if (stateError) {
      await supabase.from("tiered_positions").delete().eq("position_id", positionId);
      throw new Error(`tiered bankroll update failed: ${stateError.message}`);
    }

    await logSignal({ id, walletAddress: row.wallet_address, tokenMint: row.token_mint, seenAt, entered: true, skipReasons: [], snapshot });
    console.log(`[tiered-entry] opened ${market.symbol ?? row.token_mint.slice(0, 6)} from ${row.wallet_address.slice(0, 6)} trust ${trust}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    skipReasons.push(`evaluation_error:${message}`);
    snapshot.evaluation_error = message;
    try {
      await logSignal({ id, walletAddress: row.wallet_address, tokenMint: row.token_mint, seenAt, entered: false, skipReasons, snapshot });
    } catch (logError) {
      console.error("[tiered-entry] failed to log failed evaluation:", logError);
    }
    console.error("[tiered-entry] isolated evaluation failed:", error);
  }
}

async function evaluateNewSignals(): Promise<void> {
  if (evaluating) return;
  evaluating = true;
  try {
    const { data, error } = await supabase
      .from("wallet_transactions")
      .select("id,wallet_address,signature,token_mint,sol_amount,tx_time")
      .eq("side", "buy")
      .order("tx_time", { ascending: true })
      .limit(100);
    if (error) throw new Error(`tiered signal feed failed: ${error.message}`);

    for (const row of data ?? []) {
      const { data: existing, error: existingError } = await supabase
        .from("tiered_processed_signals")
        .select("id")
        .eq("wallet_address", row.wallet_address)
        .eq("token_mint", row.token_mint)
        .limit(1);
      if (existingError) {
        console.error("[tiered-entry] processed lookup failed; skipping fail-closed:", existingError);
        continue;
      }
      if (existing?.length) continue;
      await runSerialized(() => evaluateSignal(row));
    }
  } catch (error) {
    console.error("[tiered-entry] isolated signal loop failed:", error);
  } finally {
    evaluating = false;
  }
}

function priceIsSuspect(positionId: string, entryPrice: number, price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return true;
  const dropPct = (1 - price / entryPrice) * 100;
  if (dropPct <= SUSPECT_DROP_PCT) {
    suspectPrices.delete(positionId);
    return false;
  }

  const now = Date.now();
  const previous = suspectPrices.get(positionId);
  if (!previous || now - previous.firstSeenAt < SUSPECT_CONFIRMATION_MS) {
    if (!previous) suspectPrices.set(positionId, { firstSeenAt: now, price });
    console.warn(`[tiered-entry] price_fetch_suspect ${positionId} drop ${dropPct.toFixed(2)}%`);
    return true;
  }

  suspectPrices.delete(positionId);
  return false;
}

async function checkTieredPositions(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    await runSerialized(async () => {
      const [stateResult, positionsResult] = await Promise.all([
        supabase.from("tiered_state").select("*").eq("id", 1).single(),
        supabase.from("tiered_positions").select("*").order("entry_time", { ascending: true }),
      ]);
      const loadError = stateResult.error ?? positionsResult.error;
      if (loadError) throw new Error(`tiered position load failed: ${loadError.message}`);
      const state = stateResult.data;
      let bankroll = numberValue(state.bankroll_sol, 0);

      for (const position of positionsResult.data ?? []) {
        try {
          const raw = await getPriceUsd(position.mint);
          const rawPrice = numberValue(raw.priceUsd);
          const entryPrice = numberValue(position.entry_price);
          if (priceIsSuspect(position.position_id, entryPrice, rawPrice)) continue;
          const exitPrice = applyExitFriction(rawPrice, config.execution.exitFrictionPct);
          if (!Number.isFinite(exitPrice) || exitPrice <= 0) continue;

          const ladderHits = Array.isArray(position.ladder_hits) ? position.ladder_hits.map(Number) : [];
          const decision = evaluateSharedPaperExit({
            entryPrice,
            entryTime: Date.parse(position.entry_time),
            remainingPct: numberValue(position.remaining_pct, 1),
            peakMultiple: numberValue(position.peak_multiple, 1),
            ladderHits,
          }, exitPrice);

          if (decision.actions.length === 0) {
            await supabase.from("tiered_positions").update({ peak_multiple: decision.peakMultiple }).eq("position_id", position.position_id);
            continue;
          }

          let remaining = numberValue(position.remaining_pct, 1);
          let realized = numberValue(position.realized_pnl_sol, 0);
          const updatedHits = [...ladderHits];
          let terminal = false;

          for (const action of decision.actions) {
            const soldPct = Math.min(remaining, action.soldPct);
            if (soldPct <= 0) continue;
            const soldSizeSol = numberValue(position.size_sol, 0) * soldPct;
            const multiple = exitPrice / entryPrice;
            const proceedsSol = soldSizeSol * multiple;
            const pnlSol = proceedsSol - soldSizeSol;
            bankroll += proceedsSol;
            realized += pnlSol;
            remaining -= soldPct;
            const rung = /^ladder_(.+)x$/.exec(action.reason);
            if (rung) updatedHits.push(Number(rung[1]));

            const { error: tradeError } = await supabase.from("tiered_trades").insert({
              token_symbol: position.token_symbol,
              mint: position.mint,
              type: action.terminal ? "sell" : "partial_sell",
              reason: action.reason,
              entry_price: entryPrice,
              exit_price: exitPrice,
              multiple: Number(multiple.toFixed(4)),
              sold_pct: Number(soldPct.toFixed(4)),
              sold_size_sol: Number(soldSizeSol.toFixed(4)),
              proceeds_sol: Number(proceedsSol.toFixed(4)),
              pnl_sol: Number(pnlSol.toFixed(4)),
              hold_minutes: Number(((Date.now() - Date.parse(position.entry_time)) / 60_000).toFixed(1)),
              happened_at: new Date().toISOString(),
              entry_alert: position.entry_alert,
              position_id: position.position_id,
              entry_wallet: position.entry_wallet,
            });
            if (tradeError) throw new Error(`tiered trade insert failed: ${tradeError.message}`);
            terminal = action.terminal || remaining <= 0.001;
          }

          if (terminal) {
            await supabase.from("tiered_positions").delete().eq("position_id", position.position_id);
          } else {
            await supabase.from("tiered_positions").update({
              remaining_pct: remaining,
              peak_multiple: decision.peakMultiple,
              ladder_hits: updatedHits,
              realized_pnl_sol: realized,
            }).eq("position_id", position.position_id);
          }
        } catch (error) {
          console.error(`[tiered-entry] isolated position failure ${position.token_symbol}:`, error);
        }
      }

      await supabase.from("tiered_state").update({ bankroll_sol: bankroll, updated_at: new Date().toISOString() }).eq("id", 1);
    });
  } catch (error) {
    console.error("[tiered-entry] isolated position loop failed:", error);
  } finally {
    checking = false;
  }
}

export function startTieredEntryShadowScheduler(): void {
  console.log("tiered entry shadow v1 active");
  void evaluateNewSignals();
  void checkTieredPositions();
  setInterval(() => void evaluateNewSignals(), EVALUATION_INTERVAL_MS);
  setInterval(() => void checkTieredPositions(), POSITION_INTERVAL_MS);
}
