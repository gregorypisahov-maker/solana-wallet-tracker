import { getSupabaseAdmin } from "../lib/supabase";
import { getPriceUsd } from "./priceFeed";
import { AlertInput } from "./types";

const supabase = getSupabaseAdmin();

type LabVariant = "shadow" | "legion";

type LabState = {
  variant: LabVariant;
  bankroll_sol: number | string;
  starting_bankroll_sol: number | string;
  enabled: boolean;
};

type LabPosition = {
  variant: LabVariant;
  mint: string;
  token_symbol: string;
  entry_price: number | string;
  entry_time: string;
  size_sol: number | string;
  remaining_pct: number | string;
  peak_multiple: number | string;
  ladder_hits: Array<number | string>;
  entry_alert: AlertInput;
  position_id: string;
  realized_pnl_sol: number | string;
};

const RULES = {
  minScore: 10,
  maxScore: 65,
  minWallets: 2,
  labSingleMinAvgBuySol: 0.5,
  labSingleMinTrustScore: 60,
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
  shadowBreakEvenActivationMultiple: 1.08,
  legionProfitLockMultiple: 1.09,
  trailingActivationMultiple: 1.18,
  trailingStopPct: 0.1,
  takeProfitMultiple: 1.35,
  maxHoldMinutes: 60,
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

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadStates(): Promise<Map<LabVariant, LabState>> {
  const { data, error } = await supabase.from("lab_strategy_state").select("*");
  if (error) throw new Error(`lab state load failed: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.variant as LabVariant, row as LabState]));
}

async function loadPositions(variant?: LabVariant): Promise<LabPosition[]> {
  let query = supabase.from("lab_positions").select("*");
  if (variant) query = query.eq("variant", variant);
  const { data, error } = await query;
  if (error) throw new Error(`lab positions load failed: ${error.message}`);
  return (data ?? []) as LabPosition[];
}

function entryRejection(alert: AlertInput): string | null {
  const avgBuy = alert.walletCount > 0 ? alert.totalBoughtSol / alert.walletCount : 0;
  const liqRatio = alert.marketCapUsd > 0 ? alert.liquidityUsd / alert.marketCapUsd : 0;
  const trust = alert.averageTrustScore ?? 0;
  const isVerifiedLabSingle =
    alert.signalSource === "wallet_lab" &&
    alert.walletCount === 1 &&
    avgBuy >= RULES.labSingleMinAvgBuySol &&
    trust >= RULES.labSingleMinTrustScore;
  const isEliteTwoWalletSignal =
    alert.walletCount === 2 &&
    avgBuy >= RULES.eliteTwoWalletMinAvgBuySol &&
    trust >= RULES.eliteTwoWalletMinAvgTrustScore;

  if (alert.score < RULES.minScore) return `score ${alert.score} < ${RULES.minScore}`;
  if (alert.score > RULES.maxScore) return `score ${alert.score} > ${RULES.maxScore}`;
  if (alert.walletCount < RULES.minWallets && !isVerifiedLabSingle) {
    return `single lab wallet needs avg buy ${RULES.labSingleMinAvgBuySol}+ SOL and trust ${RULES.labSingleMinTrustScore}+`;
  }
  if (alert.walletCount === 2 && !isEliteTwoWalletSignal && avgBuy < RULES.minAvgBuySol) {
    return `2-wallet avg buy ${avgBuy.toFixed(2)} < ${RULES.minAvgBuySol}`;
  }
  if (!isVerifiedLabSingle && avgBuy < RULES.minAvgBuySol) {
    return `avg buy ${avgBuy.toFixed(2)} < ${RULES.minAvgBuySol}`;
  }
  if (trust < RULES.minAvgTrustScore) return `avg trust ${trust.toFixed(1)} < ${RULES.minAvgTrustScore}`;
  if (alert.liquidityUsd < RULES.minLiquidityUsd) {
    return `liquidity ${alert.liquidityUsd} < ${RULES.minLiquidityUsd}`;
  }
  if (liqRatio < RULES.minLiqToMcapRatio) {
    return `liq/mcap ${(liqRatio * 100).toFixed(1)}% < ${RULES.minLiqToMcapRatio * 100}%`;
  }
  if (alert.marketCapUsd < RULES.minMarketCapUsd) {
    return `market cap ${alert.marketCapUsd} < ${RULES.minMarketCapUsd}`;
  }
  if (alert.marketCapUsd > RULES.maxMarketCapUsd) {
    return `market cap ${alert.marketCapUsd} > ${RULES.maxMarketCapUsd}`;
  }
  if (alert.confidenceGrade && RULES.blockedConfidenceGrades.has(alert.confidenceGrade)) {
    return `confidence ${alert.confidenceGrade} blocked`;
  }
  return null;
}

async function openVariant(
  variant: LabVariant,
  state: LabState,
  alert: AlertInput,
  entryPrice: number
): Promise<boolean> {
  if (!state.enabled) return false;
  const positions = await loadPositions(variant);
  if (positions.some((position) => position.mint === alert.mint)) return false;
  if (positions.length >= RULES.maxPositions) {
    console.log(`[LAB ${variant.toUpperCase()} SKIP] ${alert.tokenSymbol}: max positions reached`);
    return false;
  }

  const bankroll = number(state.bankroll_sol);
  const sizeSol = bankroll * RULES.sizePct;
  if (!Number.isFinite(sizeSol) || sizeSol <= 0 || sizeSol > bankroll) return false;

  const now = Date.now();
  const { error: insertError } = await supabase.from("lab_positions").insert({
    variant,
    mint: alert.mint,
    token_symbol: alert.tokenSymbol,
    entry_price: entryPrice,
    entry_time: new Date(now).toISOString(),
    size_sol: sizeSol,
    remaining_pct: 1,
    peak_multiple: 1,
    ladder_hits: [],
    entry_alert: alert,
    position_id: `lab_${variant}_${alert.mint}_${now}`,
    realized_pnl_sol: 0,
    updated_at: new Date().toISOString(),
  });
  if (insertError) throw new Error(`lab ${variant} position insert failed: ${insertError.message}`);

  const { error: stateError } = await supabase
    .from("lab_strategy_state")
    .update({ bankroll_sol: bankroll - sizeSol, updated_at: new Date().toISOString() })
    .eq("variant", variant);
  if (stateError) throw new Error(`lab ${variant} state update failed: ${stateError.message}`);

  console.log(
    `[LAB ${variant.toUpperCase()} ENTER] ${alert.tokenSymbol} @ $${entryPrice} | ` +
      `${sizeSol.toFixed(3)} SOL | lab wallets ${alert.walletCount}`
  );
  return true;
}

export async function onLabAlert(alert: AlertInput): Promise<void> {
  return serialized(async () => {
    const rejection = entryRejection(alert);
    if (rejection) {
      console.log(`[LAB REJECT] ${alert.tokenSymbol}: ${rejection}`);
      return;
    }

    const states = await loadStates();
    const enabled = (["shadow", "legion"] as LabVariant[]).filter(
      (variant) => states.get(variant)?.enabled
    );
    if (enabled.length === 0) return;

    const entryPrice = (await getPriceUsd(alert.mint)).priceUsd;
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;

    for (const variant of enabled) {
      const state = states.get(variant);
      if (state) await openVariant(variant, state, alert, entryPrice);
    }
  });
}

async function recordSell(input: {
  position: LabPosition;
  currentPrice: number;
  soldPct: number;
  reason: string;
}): Promise<{ proceeds: number; pnl: number }> {
  const entryPrice = number(input.position.entry_price);
  const multiple = input.currentPrice / entryPrice;
  const soldSize = number(input.position.size_sol) * input.soldPct;
  const proceeds = soldSize * multiple;
  const pnl = proceeds - soldSize;
  const holdMinutes = (Date.now() - Date.parse(input.position.entry_time)) / 60_000;

  const { error } = await supabase.from("lab_trades").insert({
    variant: input.position.variant,
    position_id: input.position.position_id,
    token_symbol: input.position.token_symbol,
    mint: input.position.mint,
    type: input.soldPct < number(input.position.remaining_pct) ? "partial_sell" : "sell",
    reason: input.reason,
    entry_price: entryPrice,
    exit_price: input.currentPrice,
    multiple: Number(multiple.toFixed(4)),
    sold_pct: Number(input.soldPct.toFixed(4)),
    pnl_sol: Number(pnl.toFixed(6)),
    hold_minutes: Number(holdMinutes.toFixed(2)),
    happened_at: new Date().toISOString(),
    entry_alert: input.position.entry_alert,
  });
  if (error) throw new Error(`lab trade insert failed: ${error.message}`);

  console.log(
    `[LAB ${input.position.variant.toUpperCase()} SELL] ${input.position.token_symbol} ` +
      `${(input.soldPct * 100).toFixed(0)}% @ ${multiple.toFixed(2)}x (${input.reason}) | ` +
      `${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} SOL`
  );
  return { proceeds, pnl };
}

async function checkVariant(variant: LabVariant, state: LabState): Promise<void> {
  if (!state.enabled) return;
  let bankroll = number(state.bankroll_sol);
  const positions = await loadPositions(variant);

  for (const position of positions) {
    try {
      const currentPrice = (await getPriceUsd(position.mint)).priceUsd;
      const entryPrice = number(position.entry_price);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0 || entryPrice <= 0) continue;

      const currentMultiple = currentPrice / entryPrice;
      const peakMultiple = Math.max(number(position.peak_multiple, 1), currentMultiple);
      const holdMinutes = (Date.now() - Date.parse(position.entry_time)) / 60_000;
      let remaining = number(position.remaining_pct, 1);
      let realized = number(position.realized_pnl_sol);
      const ladderHits = (position.ladder_hits ?? []).map((value) => number(value));

      if (
        variant === "legion" &&
        !ladderHits.includes(RULES.legionProfitLockMultiple) &&
        currentMultiple >= RULES.legionProfitLockMultiple &&
        remaining > 0.5
      ) {
        const soldPct = Math.min(0.5, remaining);
        const sale = await recordSell({
          position: { ...position, remaining_pct: remaining },
          currentPrice,
          soldPct,
          reason: "profit_lock_9pct",
        });
        bankroll += sale.proceeds;
        realized += sale.pnl;
        remaining -= soldPct;
        ladderHits.push(RULES.legionProfitLockMultiple);
      }

      let reason: string | null = null;
      if (currentMultiple <= 1 - RULES.hardStopPct) {
        reason = "hard_stop_loss";
      } else if (
        variant === "shadow" &&
        peakMultiple >= RULES.shadowBreakEvenActivationMultiple &&
        currentMultiple <= 1
      ) {
        reason = "break_even_protection";
      } else if (
        variant === "legion" &&
        ladderHits.includes(RULES.legionProfitLockMultiple) &&
        currentMultiple <= 1
      ) {
        reason = "break_even_remainder";
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

      if (reason && remaining > 0.001) {
        const sale = await recordSell({
          position: { ...position, remaining_pct: remaining },
          currentPrice,
          soldPct: remaining,
          reason,
        });
        bankroll += sale.proceeds;
        realized += sale.pnl;
        remaining = 0;
      }

      if (remaining <= 0.001) {
        const { error } = await supabase
          .from("lab_positions")
          .delete()
          .eq("variant", variant)
          .eq("mint", position.mint);
        if (error) throw new Error(`lab position delete failed: ${error.message}`);
      } else {
        const { error } = await supabase
          .from("lab_positions")
          .update({
            remaining_pct: remaining,
            peak_multiple: peakMultiple,
            ladder_hits: ladderHits,
            realized_pnl_sol: realized,
            updated_at: new Date().toISOString(),
          })
          .eq("variant", variant)
          .eq("mint", position.mint);
        if (error) throw new Error(`lab position update failed: ${error.message}`);
      }
    } catch (error) {
      console.error(`[lab-strategy] ${variant} ${position.token_symbol} check failed:`, error);
    }
  }

  const { error } = await supabase
    .from("lab_strategy_state")
    .update({ bankroll_sol: bankroll, updated_at: new Date().toISOString() })
    .eq("variant", variant);
  if (error) throw new Error(`lab ${variant} bankroll save failed: ${error.message}`);
}

export async function checkLabPositions(): Promise<void> {
  return serialized(async () => {
    const states = await loadStates();
    for (const variant of ["shadow", "legion"] as LabVariant[]) {
      const state = states.get(variant);
      if (state) await checkVariant(variant, state);
    }
  });
}
