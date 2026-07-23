import { getSupabaseAdmin } from "../lib/supabase";
import {
  PAPER_COST_MODEL,
  appendFailedPaperEntry,
  calculateEntryExecutionCosts,
  calculateExitExecutionCosts,
  shouldSimulateFailedEntry,
} from "./executionCosts";
import { getPriceUsd } from "./priceFeed";
import { AlertInput } from "./types";

const supabase = getSupabaseAdmin();

const RULES = {
  minScore: 10,
  maxScore: 65,
  minWallets: 3,
  minAvgBuySol: 0.75,
  minAvgTrustScore: 55,
  eliteTwoWalletMinAvgBuySol: 1.25,
  eliteTwoWalletMinAvgTrustScore: 60,
  minLiquidityUsd: 15_000,
  minLiqToMcapRatio: 0.15,
  minMarketCapUsd: 20_000,
  maxMarketCapUsd: 200_000,
  blockedConfidenceGrades: new Set(["D"]),
  sizePct: 0.03,
  maxPositions: 3,
  hardStopPct: 0.12,
  breakEvenActivationMultiple: 1.08,
  trailingActivationMultiple: 1.18,
  trailingStopPct: 0.10,
  takeProfitMultiple: 1.35,
  maxHoldMinutes: 60,
};

type ShadowState = {
  bankroll_sol: number | string;
  starting_bankroll_sol: number | string;
  enabled: boolean;
};

type ShadowPosition = {
  mint: string;
  token_symbol: string;
  entry_price: number | string;
  entry_time: string;
  size_sol: number | string;
  remaining_pct: number | string;
  peak_multiple: number | string;
  entry_alert: AlertInput;
  position_id: string;
  realized_pnl_sol: number | string;
  entry_fee_sol: number | string;
  entry_slippage_sol: number | string;
  entry_liquidity_usd: number | string | null;
  cost_model_version: string | null;
};

let operationTail: Promise<void> = Promise.resolve();

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const previous = operationTail;
  let release!: () => void;
  operationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function loadState(): Promise<ShadowState> {
  const { data, error } = await supabase
    .from("shadow_strategy_state")
    .select("bankroll_sol, starting_bankroll_sol, enabled")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`shadow state load failed: ${error.message}`);
  return data;
}

async function loadPositions(): Promise<ShadowPosition[]> {
  const { data, error } = await supabase
    .from("shadow_positions")
    .select(
      "mint,token_symbol,entry_price,entry_time,size_sol,remaining_pct,peak_multiple,entry_alert,position_id,realized_pnl_sol,entry_fee_sol,entry_slippage_sol,entry_liquidity_usd,cost_model_version"
    );
  if (error) throw new Error(`shadow positions load failed: ${error.message}`);
  return (data ?? []) as ShadowPosition[];
}

function entryRejection(alert: AlertInput): string | null {
  const avgBuy = alert.walletCount > 0 ? alert.totalBoughtSol / alert.walletCount : 0;
  const liqRatio = alert.marketCapUsd > 0 ? alert.liquidityUsd / alert.marketCapUsd : 0;
  const isEliteTwoWalletSignal =
    alert.walletCount === 2 &&
    avgBuy >= RULES.eliteTwoWalletMinAvgBuySol &&
    alert.averageTrustScore !== undefined &&
    alert.averageTrustScore >= RULES.eliteTwoWalletMinAvgTrustScore;

  if (alert.score < RULES.minScore) return `score ${alert.score} < ${RULES.minScore}`;
  if (alert.score > RULES.maxScore) return `score ${alert.score} > ${RULES.maxScore} (late-entry guard)`;
  if (alert.walletCount < RULES.minWallets && !isEliteTwoWalletSignal) {
    if (alert.walletCount === 2) {
      return `2-wallet signal needs avg buy >= ${RULES.eliteTwoWalletMinAvgBuySol} and avg trust >= ${RULES.eliteTwoWalletMinAvgTrustScore}`;
    }
    return `wallets ${alert.walletCount} < ${RULES.minWallets}`;
  }
  if (avgBuy < RULES.minAvgBuySol) return `avg buy ${avgBuy.toFixed(2)} < ${RULES.minAvgBuySol}`;
  if (alert.averageTrustScore === undefined || alert.averageTrustScore < RULES.minAvgTrustScore) {
    return `avg trust ${alert.averageTrustScore ?? "n/a"} < ${RULES.minAvgTrustScore}`;
  }
  if (alert.liquidityUsd < RULES.minLiquidityUsd) return `liquidity ${alert.liquidityUsd} < ${RULES.minLiquidityUsd}`;
  if (liqRatio < RULES.minLiqToMcapRatio) return `liq/mcap ${(liqRatio * 100).toFixed(1)}% < ${RULES.minLiqToMcapRatio * 100}%`;
  if (alert.marketCapUsd < RULES.minMarketCapUsd) return `market cap ${alert.marketCapUsd} < ${RULES.minMarketCapUsd}`;
  if (alert.marketCapUsd > RULES.maxMarketCapUsd) return `market cap ${alert.marketCapUsd} > ${RULES.maxMarketCapUsd}`;
  if (alert.confidenceGrade && RULES.blockedConfidenceGrades.has(alert.confidenceGrade)) {
    return `confidence ${alert.confidenceGrade} blocked`;
  }
  if (
    alert.shadowSizeMultiplier !== undefined &&
    (!Number.isFinite(alert.shadowSizeMultiplier) ||
      alert.shadowSizeMultiplier <= 0 ||
      alert.shadowSizeMultiplier > 1)
  ) {
    return `invalid shadow size multiplier ${alert.shadowSizeMultiplier}`;
  }
  return null;
}

export async function onShadowAlert(alert: AlertInput): Promise<void> {
  return serialized(async () => {
    const state = await loadState();
    if (!state.enabled) return;

    const rejection = entryRejection(alert);
    if (rejection) {
      console.log(`[SHADOW REJECT] ${alert.tokenSymbol}: ${rejection}`);
      return;
    }

    const positions = await loadPositions();
    if (positions.some((position) => position.mint === alert.mint)) return;
    if (positions.length >= RULES.maxPositions) {
      console.log(`[SHADOW SKIP] ${alert.tokenSymbol}: max positions reached`);
      return;
    }

    const bankroll = Number(state.bankroll_sol);
    const sizeMultiplier = alert.shadowSizeMultiplier ?? 1;
    const normalSizeSol = bankroll * RULES.sizePct;
    const sizeSol = normalSizeSol * sizeMultiplier;
    if (!Number.isFinite(sizeSol) || sizeSol <= 0 || sizeSol > bankroll) return;

    if (alert.shadowStudyDecision && typeof alert.shadowStudyDecision === "object") {
      alert.shadowStudyDecision.signal_multiplier = sizeMultiplier;
      alert.shadowStudyDecision.normal_shadow_size_sol = normalSizeSol;
      alert.shadowStudyDecision.final_shadow_size_sol = sizeSol;
    }

    const priceData = await getPriceUsd(alert.mint);
    const price = priceData.priceUsd;
    const entryLiquidityUsd = priceData.liquidityUsd ?? alert.liquidityUsd;
    if (!Number.isFinite(price) || price <= 0) return;

    let entryCosts;
    try {
      entryCosts = calculateEntryExecutionCosts(sizeSol, entryLiquidityUsd);
    } catch (error) {
      console.error(`[SHADOW SKIP] ${alert.tokenSymbol}: cost model failed closed`, error);
      return;
    }

    if (shouldSimulateFailedEntry()) {
      const updatedBankroll = bankroll - entryCosts.networkFeeSol;
      const { error: failedStateError } = await supabase
        .from("shadow_strategy_state")
        .update({ bankroll_sol: updatedBankroll, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (failedStateError) throw new Error(`shadow failed-entry debit failed: ${failedStateError.message}`);
      await appendFailedPaperEntry({
        strategy: "SHADOW",
        mint: alert.mint,
        tokenSymbol: alert.tokenSymbol,
        attemptedSizeSol: sizeSol,
        liquidityUsd: entryLiquidityUsd,
        networkFeeSol: entryCosts.networkFeeSol,
        snapshot: { score: alert.score, wallet_count: alert.walletCount },
      });
      console.log(
        `[SHADOW FAILED ENTRY] ${alert.tokenSymbol}: charged ${entryCosts.networkFeeSol.toFixed(6)} SOL; no position`
      );
      return;
    }

    const totalEntryDebitSol = sizeSol + entryCosts.totalSol;
    if (totalEntryDebitSol > bankroll) {
      console.log(`[SHADOW SKIP] ${alert.tokenSymbol}: insufficient cash after costs`);
      return;
    }

    const now = Date.now();
    const positionId = `shadow_${alert.mint}_${now}`;
    const { error: insertError } = await supabase.from("shadow_positions").insert({
      mint: alert.mint,
      token_symbol: alert.tokenSymbol,
      entry_price: price,
      entry_time: new Date(now).toISOString(),
      size_sol: sizeSol,
      remaining_pct: 1,
      peak_multiple: 1,
      entry_alert: alert,
      position_id: positionId,
      realized_pnl_sol: 0,
      entry_fee_sol: entryCosts.networkFeeSol + entryCosts.swapFeeSol,
      entry_slippage_sol: entryCosts.slippageSol,
      entry_liquidity_usd: entryLiquidityUsd,
      cost_model_version: PAPER_COST_MODEL.enabled ? PAPER_COST_MODEL.version : null,
      updated_at: new Date().toISOString(),
    });
    if (insertError) throw new Error(`shadow position insert failed: ${insertError.message}`);

    const { error: stateError } = await supabase
      .from("shadow_strategy_state")
      .update({ bankroll_sol: bankroll - totalEntryDebitSol, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (stateError) throw new Error(`shadow state update failed: ${stateError.message}`);

    console.log(
      `[SHADOW ENTER] ${alert.tokenSymbol} @ $${price} | size ${sizeSol.toFixed(3)} SOL | ` +
        `entry costs ${entryCosts.totalSol.toFixed(6)} SOL | multiplier ${sizeMultiplier.toFixed(3)} | score ${alert.score}`
    );
  });
}

export async function checkShadowPositions(): Promise<void> {
  return serialized(async () => {
    const state = await loadState();
    if (!state.enabled) return;

    let bankroll = Number(state.bankroll_sol);
    const positions = await loadPositions();

    for (const position of positions) {
      try {
        const priceData = await getPriceUsd(position.mint);
        const currentPrice = priceData.priceUsd;
        const entryPrice = Number(position.entry_price);
        const currentMultiple = currentPrice / entryPrice;
        const peakMultiple = Math.max(Number(position.peak_multiple), currentMultiple);
        const holdMinutes = (Date.now() - Date.parse(position.entry_time)) / 60_000;

        let reason: string | null = null;
        if (currentMultiple <= 1 - RULES.hardStopPct) {
          reason = "hard_stop_loss";
        } else if (
          peakMultiple >= RULES.breakEvenActivationMultiple &&
          currentMultiple <= 1
        ) {
          reason = "break_even_protection";
        } else if (
          peakMultiple >= RULES.trailingActivationMultiple &&
          currentMultiple <= Math.max(1, peakMultiple * (1 - RULES.trailingStopPct))
        ) {
          reason = "trailing_stop";
        } else if (currentMultiple >= RULES.takeProfitMultiple) {
          reason = "take_profit";
        } else if (holdMinutes >= RULES.maxHoldMinutes) {
          reason = "max_hold_time";
        }

        if (!reason) {
          if (peakMultiple !== Number(position.peak_multiple)) {
            await supabase
              .from("shadow_positions")
              .update({ peak_multiple: peakMultiple, updated_at: new Date().toISOString() })
              .eq("mint", position.mint);
          }
          continue;
        }

        const soldPct = Number(position.remaining_pct);
        const sizeSol = Number(position.size_sol) * soldPct;
        const grossProceeds = sizeSol * currentMultiple;
        const grossPnl = grossProceeds - sizeSol;
        const exitLiquidityUsd =
          priceData.liquidityUsd ??
          Number(position.entry_liquidity_usd ?? position.entry_alert.liquidityUsd);
        const exitCosts = calculateExitExecutionCosts(grossProceeds, exitLiquidityUsd);
        const allocatedEntryFee = Number(position.entry_fee_sol ?? 0) * soldPct;
        const allocatedEntrySlippage = Number(position.entry_slippage_sol ?? 0) * soldPct;
        const exitFee = exitCosts.networkFeeSol + exitCosts.swapFeeSol;
        const slippage = allocatedEntrySlippage + exitCosts.slippageSol;
        const proceeds = grossProceeds - exitCosts.totalSol;
        const pnl = grossPnl - allocatedEntryFee - exitFee - slippage;
        bankroll += proceeds;

        const { error: tradeError } = await supabase.from("shadow_trades").insert({
          position_id: position.position_id,
          token_symbol: position.token_symbol,
          mint: position.mint,
          reason,
          entry_price: entryPrice,
          exit_price: currentPrice,
          multiple: Number(currentMultiple.toFixed(6)),
          sold_pct: soldPct,
          entry_fee_sol: allocatedEntryFee,
          exit_fee_sol: exitFee,
          slippage_sol: slippage,
          gross_pnl_sol: grossPnl,
          pnl_sol: pnl,
          cost_model_version:
            position.cost_model_version ??
            (PAPER_COST_MODEL.enabled ? PAPER_COST_MODEL.version : null),
          happened_at: new Date().toISOString(),
          entry_alert: position.entry_alert,
        });
        if (tradeError) throw new Error(`shadow trade insert failed: ${tradeError.message}`);

        const { error: deleteError } = await supabase
          .from("shadow_positions")
          .delete()
          .eq("mint", position.mint);
        if (deleteError) throw new Error(`shadow position delete failed: ${deleteError.message}`);

        console.log(
          `[SHADOW EXIT] ${position.token_symbol} ${currentMultiple.toFixed(2)}x ` +
            `(${reason}) | gross ${grossPnl >= 0 ? "+" : ""}${grossPnl.toFixed(3)} SOL | ` +
            `net ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} SOL`
        );
      } catch (error) {
        console.error(`[shadow-strategy] ${position.token_symbol} check failed:`, error);
      }
    }

    const { error: stateError } = await supabase
      .from("shadow_strategy_state")
      .update({ bankroll_sol: bankroll, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (stateError) throw new Error(`shadow bankroll save failed: ${stateError.message}`);
  });
}

export async function getShadowSummary(): Promise<{
  bankrollSol: number;
  openPositionValueSol: number;
  equitySol: number;
  completedTrades: number;
  totalPnlSol: number;
}> {
  const [state, positions, tradesResult] = await Promise.all([
    loadState(),
    loadPositions(),
    supabase.from("shadow_trades").select("pnl_sol"),
  ]);
  if (tradesResult.error) throw new Error(`shadow trades load failed: ${tradesResult.error.message}`);

  const openPositionValueSol = positions.reduce(
    (sum, position) => sum + Number(position.size_sol) * Number(position.remaining_pct),
    0
  );
  const totalPnlSol = (tradesResult.data ?? []).reduce(
    (sum, trade) => sum + Number(trade.pnl_sol),
    0
  );
  const bankrollSol = Number(state.bankroll_sol);

  return {
    bankrollSol,
    openPositionValueSol,
    equitySol: bankrollSol + openPositionValueSol,
    completedTrades: tradesResult.data?.length ?? 0,
    totalPnlSol,
  };
}
