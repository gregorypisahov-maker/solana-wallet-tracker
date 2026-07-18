// paper-trader/engine.ts
// Paper-trading simulator.
// No real funds are moved.
//
// This version sends a Telegram message at every stage:
// 1. Alert received
// 2. Entry accepted, rejected, or skipped
// 3. Position opened
// 4. Position partially or fully sold
//
// CHANGE FROM PREVIOUS VERSION: positions now carry a stable positionId,
// generated once when the position opens, and every TradeRecord written
// for that position (partial sells and the final close) carries the same
// positionId. This lets analytics correctly group partial sells into one
// logical trade instead of counting each sell as a separate trade. No
// other behavior changed: halt logic, sizing, ladder/trailing/stop-loss
// exits, and all Telegram message text are unchanged from before.

import { config } from "./config";
import { evaluateEntry } from "./entryFilter";
import { applyEntryFriction, applyExitFriction } from "./executionFriction";
import { getPriceUsd } from "./priceFeed";
import { REGULAR_STRATEGY_VERSION } from "./strategyVersion";
import {
  loadState,
  saveState,
  appendTrade,
  loadOpenPositions,
  saveOpenPosition,
  deleteOpenPosition,
} from "./storage";
import {
  AlertInput,
  OpenPosition,
  PaperState,
  TradeRecord,
} from "./types";
import { sendTelegramAlert } from "../lib/telegram";

// onAlert() and checkPositions() are started by different timers. Without a
// shared lock they can both load the same cash balance, modify it, and then
// overwrite each other's save. Keep every read/modify/write cycle serialized
// so paper_state and paper_positions always move forward in one order.
let engineOperationTail: Promise<void> = Promise.resolve();

async function runEngineOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previousOperation = engineOperationTail;
  let releaseCurrentOperation!: () => void;

  engineOperationTail = new Promise<void>((resolve) => {
    releaseCurrentOperation = resolve;
  });

  await previousOperation;

  try {
    return await operation();
  } finally {
    releaseCurrentOperation();
  }
}

async function notify(message: string): Promise<void> {
  try {
    await sendTelegramAlert(message);
  } catch (err) {
    console.error("[paper-trader] Telegram notification failed:", err);
  }
}

function makePositionId(mint: string, entryTime: number): string {
  return `${mint}_${entryTime}`;
}

function calculateCostBasisEquity(
  state: PaperState,
  openPositions: Map<string, OpenPosition>
): number {
  let committedCapitalSol = 0;

  for (const position of openPositions.values()) {
    committedCapitalSol += position.sizeSol * position.remainingPct;
  }

  return state.bankrollSol + committedCapitalSol;
}

function resetDailyIfNeeded(
  state: PaperState,
  openPositions: Map<string, OpenPosition>
): PaperState {
  const today = new Date().toDateString();

  if (state.dailyResetDate !== today) {
    state.dailyResetDate = today;

    // Cash plus the original value still committed to open positions.
    state.dailyStartBankrollSol = calculateCostBasisEquity(
      state,
      openPositions
    );

    state.consecutiveLosses = 0;
    state.halted = false;
    state.haltReason = null;
  }

  return state;
}

function checkTradingHalt(
  state: PaperState,
  openPositions: Map<string, OpenPosition>
): { halted: boolean; reason: string | null } {
  const currentEquitySol = calculateCostBasisEquity(
    state,
    openPositions
  );

  const maximumDailyLossSol =
    state.dailyStartBankrollSol *
    config.risk.dailyLossLimitPct;

  const currentDailyLossSol =
    state.dailyStartBankrollSol -
    currentEquitySol;

  if (currentDailyLossSol >= maximumDailyLossSol) {
    return {
      halted: true,
      reason:
        `Daily loss limit reached: ` +
        `-${currentDailyLossSol.toFixed(3)} SOL`,
    };
  }

  if (
    state.consecutiveLosses >=
    config.risk.maxLossesInARow
  ) {
    return {
      halted: true,
      reason:
        `${state.consecutiveLosses} consecutive losses`,
    };
  }

  return {
    halted: false,
    reason: null,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

// Called by worker/monitor.ts after a new consensus alert.
export async function onAlert(
  alert: AlertInput
): Promise<void> {
  return runEngineOperation(() => processAlert(alert));
}

async function processAlert(
  alert: AlertInput
): Promise<void> {
  alert = {
    ...alert,
    signalSource: alert.signalSource ?? "wallet_consensus",
    strategyVersion: REGULAR_STRATEGY_VERSION,
  };
  const sourceLabel =
    alert.signalSource === "proven_trader_copy"
      ? "verified profitable trader"
      : "wallet consensus";

  console.log(
    `[PAPER RECEIVED] ${alert.tokenSymbol} | ` +
      `score ${alert.score} | wallets ${alert.walletCount} | ${sourceLabel}`
  );

  // This confirms in Telegram that onAlert() was reached.
  await notify(
    `🔎 <b>[PAPER] Alert received</b>\n\n` +
      `Token: <b>${alert.tokenSymbol}</b>\n` +
      `Signal: <b>${sourceLabel}</b>\n` +
      `Score: ${alert.score}\n` +
      `Wallets: ${alert.walletCount}\n` +
      `Total bought: ${alert.totalBoughtSol.toFixed(2)} SOL\n` +
      `Market cap: $${alert.marketCapUsd.toLocaleString()}\n` +
      `Liquidity: $${alert.liquidityUsd.toLocaleString()}`
  );

  let state: PaperState;
  let openPositions: Map<string, OpenPosition>;

  try {
    state = await loadState();
    openPositions = await loadOpenPositions();
  } catch (error) {
    const reason = getErrorMessage(error);

    console.error(
      `[paper-trader] Failed to load simulator state: ${reason}`
    );

    await notify(
      `❌ <b>[PAPER] Simulator error</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Could not load paper-trading state.\n` +
        `Reason: ${reason}`
    );

    return;
  }

  state = resetDailyIfNeeded(
    state,
    openPositions
  );

  const haltCheck = checkTradingHalt(
    state,
    openPositions
  );

  if (haltCheck.halted) {
    state.halted = true;
    state.haltReason = haltCheck.reason;

    await saveState(state);

    console.log(
      `[PAPER SKIP] ${alert.tokenSymbol}: ${haltCheck.reason}`
    );

    await notify(
      `⏸️ <b>[PAPER] Trading halted</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Reason: ${haltCheck.reason}`
    );

    return;
  }

  if (state.halted || state.haltReason) {
    state.halted = false;
    state.haltReason = null;
    await saveState(state);
  }

  if (
    openPositions.size >=
    config.position.maxConcurrentPositions
  ) {
    const reason =
      `Maximum open positions reached ` +
      `(${openPositions.size}/${config.position.maxConcurrentPositions})`;

    console.log(
      `[PAPER SKIP] ${alert.tokenSymbol}: ${reason}`
    );

    await notify(
      `⏭️ <b>[PAPER] Trade skipped</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Reason: ${reason}`
    );

    return;
  }

  if (openPositions.has(alert.mint)) {
    const reason =
      "A paper position for this token is already open";

    console.log(
      `[PAPER SKIP] ${alert.tokenSymbol}: ${reason}`
    );

    await notify(
      `⏭️ <b>[PAPER] Trade skipped</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Reason: ${reason}`
    );

    return;
  }

  const evaluation = evaluateEntry(alert);

  if (!evaluation.pass) {
    const reasons = evaluation.reasons.join("\n• ");

    console.log(
      `[PAPER REJECT] ${alert.tokenSymbol}: ` +
        evaluation.reasons.join("; ")
    );

    await notify(
      `🟠 <b>[PAPER] Entry rejected</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Score: ${alert.score}\n` +
        `Wallets: ${alert.walletCount}\n` +
        `Average buy: ${evaluation.avgBuyPerWallet.toFixed(2)} SOL\n` +
        `Liquidity/MCap: ${(evaluation.liqToMcap * 100).toFixed(1)}%\n\n` +
        `<b>Reasons:</b>\n• ${reasons}`
    );

    return;
  }

  let entryPrice: number;

  try {
    const priceData = await getPriceUsd(alert.mint);
    entryPrice = applyEntryFriction(
      priceData.priceUsd,
      config.execution.entryFrictionPct
    );

    if (
      !Number.isFinite(entryPrice) ||
      entryPrice <= 0
    ) {
      throw new Error(
        `Invalid entry price returned: ${entryPrice}`
      );
    }
  } catch (error) {
    const reason = getErrorMessage(error);

    console.log(
      `[PAPER SKIP] ${alert.tokenSymbol}: ` +
        `price fetch failed — ${reason}`
    );

    await notify(
      `⏭️ <b>[PAPER] Trade skipped</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Reason: Price fetch failed\n` +
        `Details: ${reason}`
    );

    return;
  }

  const sizeSol =
    state.bankrollSol *
    config.position.sizePctPerTrade *
    (alert.signalSource === "proven_trader_copy"
      ? config.position.provenTraderSizeMultiplier
      : 1);

  if (
    !Number.isFinite(sizeSol) ||
    sizeSol <= 0
  ) {
    await notify(
      `❌ <b>[PAPER] Position-size error</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Calculated size: ${sizeSol}`
    );

    return;
  }

  if (sizeSol > state.bankrollSol) {
    await notify(
      `⏭️ <b>[PAPER] Trade skipped</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Reason: Insufficient simulated bankroll`
    );

    return;
  }

  const entryTime = Date.now();

  const position: OpenPosition = {
    mint: alert.mint,
    tokenSymbol: alert.tokenSymbol,
    entryPrice,
    entryTime,
    sizeSol,
    remainingPct: 1,
    peakMultiple: 1,
    ladderHits: [],
    entryAlert: alert,
    positionId: makePositionId(alert.mint, entryTime),
    realizedPnlSol: 0,
  };

  try {
    await saveOpenPosition(position);

    state.bankrollSol -= sizeSol;
    await saveState(state);
  } catch (error) {
    const reason = getErrorMessage(error);

    console.error(
      `[paper-trader] Failed to save position: ${reason}`
    );

    await notify(
      `❌ <b>[PAPER] Could not open position</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Reason: ${reason}`
    );

    return;
  }

  console.log(
    `[PAPER ENTER] ${alert.tokenSymbol} ` +
      `@ $${entryPrice} | ` +
      `size ${sizeSol.toFixed(3)} SOL | ` +
      `score ${alert.score}`
  );

  if (config.telegram.notifyOnEntry) {
    await notify(
      `🟢 <b>[PAPER] Position opened</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Signal: <b>${sourceLabel}</b>\n` +
        `Size: ${sizeSol.toFixed(3)} SOL\n` +
        `Entry price: $${entryPrice}\n` +
        `Score: ${alert.score}\n` +
        `Wallets: ${alert.walletCount}\n` +
        `Average buy: ${evaluation.avgBuyPerWallet.toFixed(2)} SOL\n` +
        `Market cap: $${alert.marketCapUsd.toLocaleString()}\n` +
        `Liquidity: $${alert.liquidityUsd.toLocaleString()}\n` +
        `Liquidity/MCap: ${(evaluation.liqToMcap * 100).toFixed(1)}%\n` +
        `Paper friction: ${(
          (config.execution.entryFrictionPct +
            config.execution.exitFrictionPct) *
          100
        ).toFixed(1)}% round trip\n` +
        `Cash remaining: ${state.bankrollSol.toFixed(3)} SOL`
    );
  }
}

// Called every five seconds by worker/monitor.ts.
export async function checkPositions(): Promise<void> {
  return runEngineOperation(processOpenPositions);
}

async function processOpenPositions(): Promise<void> {
  const state = await loadState();
  const openPositions = await loadOpenPositions();

  for (const [mint, position] of openPositions.entries()) {
    let currentPrice: number;

    try {
      const priceData = await getPriceUsd(mint);
      currentPrice = applyExitFriction(
        priceData.priceUsd,
        config.execution.exitFrictionPct
      );

      if (
        !Number.isFinite(currentPrice) ||
        currentPrice <= 0
      ) {
        throw new Error(
          `Invalid current price returned: ${currentPrice}`
        );
      }
    } catch (error) {
      console.log(
        `[PAPER WARN] ${position.tokenSymbol}: ` +
          `price check failed — ${getErrorMessage(error)}`
      );

      continue;
    }

    const currentMultiple =
      currentPrice / position.entryPrice;

    position.peakMultiple = Math.max(
      position.peakMultiple,
      currentMultiple
    );

    const holdMinutes =
      (Date.now() - position.entryTime) /
      60_000;

    if (
      currentMultiple <=
      1 - config.exit.hardStopLossPct
    ) {
      await closePosition(
        position,
        currentPrice,
        position.remainingPct,
        "hard_stop_loss",
        state
      );

      continue;
    }

    if (
      position.peakMultiple >=
        config.exit.breakEvenActivationMultiple &&
      currentMultiple <= 1
    ) {
      await closePosition(
        position,
        currentPrice,
        position.remainingPct,
        "break_even_protection",
        state
      );

      continue;
    }

    if (
      holdMinutes >=
      config.exit.maxHoldMinutes
    ) {
      await closePosition(
        position,
        currentPrice,
        position.remainingPct,
        "max_hold_time",
        state
      );

      continue;
    }

    if (
      position.peakMultiple >=
      config.exit.trailingActivationMultiple
    ) {
      const trailingFloor =
        position.peakMultiple *
        (1 - config.exit.trailingStopPct);

      if (currentMultiple <= trailingFloor) {
        await closePosition(
          position,
          currentPrice,
          position.remainingPct,
          "trailing_stop",
          state
        );

        continue;
      }
    }

    let positionChanged = false;

    for (const rung of config.exit.takeProfitLadder) {
      const alreadyHit =
        position.ladderHits.includes(
          rung.atMultiple
        );

      if (
        !alreadyHit &&
        currentMultiple >= rung.atMultiple
      ) {
        const sellPct =
          position.remainingPct *
          rung.sellPct;

        position.remainingPct -= sellPct;
        position.ladderHits.push(
          rung.atMultiple
        );

        await partialSell(
          position,
          currentPrice,
          sellPct,
          `ladder_${rung.atMultiple}x`,
          state
        );

        positionChanged = true;
      }
    }

    if (position.remainingPct <= 0.001) {
      await deleteOpenPosition(mint);
    } else {
      await saveOpenPosition(position);
    }

    if (positionChanged) {
      console.log(
        `[PAPER UPDATE] ${position.tokenSymbol}: ` +
          `${(position.remainingPct * 100).toFixed(1)}% remaining`
      );
    }
  }
}

async function partialSell(
  position: OpenPosition,
  exitPrice: number,
  soldPct: number,
  reason: string,
  state: PaperState
): Promise<void> {
  if (soldPct <= 0) {
    return;
  }

  const soldSizeSol =
    position.sizeSol * soldPct;

  const multiple =
    exitPrice / position.entryPrice;

  const proceedsSol =
    soldSizeSol * multiple;

  const pnlSol =
    proceedsSol - soldSizeSol;

  state.bankrollSol += proceedsSol;
  position.realizedPnlSol += pnlSol;

  const trade: TradeRecord = {
    tokenSymbol: position.tokenSymbol,
    mint: position.mint,
    type: "partial_sell",
    reason,
    entryPrice: position.entryPrice,
    exitPrice,
    multiple: Number(
      multiple.toFixed(4)
    ),
    soldPct: Number(
      soldPct.toFixed(4)
    ),
    soldSizeSol: Number(
      soldSizeSol.toFixed(4)
    ),
    proceedsSol: Number(
      proceedsSol.toFixed(4)
    ),
    pnlSol: Number(
      pnlSol.toFixed(4)
    ),
    holdMinutes: Number(
      (
        (Date.now() - position.entryTime) /
        60_000
      ).toFixed(1)
    ),
    timestamp: new Date().toISOString(),
    entryAlert: position.entryAlert,
    positionId: position.positionId,
  };

  await appendTrade(trade);
  await saveState(state);

  console.log(
    `[PAPER SELL ${(soldPct * 100).toFixed(0)}%] ` +
      `${position.tokenSymbol} @ ` +
      `${multiple.toFixed(2)}x (${reason}) | ` +
      `PnL ${pnlSol.toFixed(3)} SOL`
  );

  if (config.telegram.notifyOnExit) {
    const emoji =
      pnlSol >= 0 ? "✅" : "🔻";

    await notify(
      `${emoji} <b>[PAPER] Position sold</b>\n\n` +
        `Token: <b>${position.tokenSymbol}</b>\n` +
        `Sold: ${(soldPct * 100).toFixed(0)}%\n` +
        `Reason: ${reason}\n` +
        `Result: ${multiple.toFixed(2)}x\n` +
        `PnL: ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(3)} SOL\n` +
        `Held: ${trade.holdMinutes} minutes\n` +
        `Bankroll: ${state.bankrollSol.toFixed(3)} SOL`
    );
  }
}

async function closePosition(
  position: OpenPosition,
  exitPrice: number,
  remainingPct: number,
  reason: string,
  state: PaperState
): Promise<void> {
  await partialSell(
    position,
    exitPrice,
    remainingPct,
    reason,
    state
  );

  updateStreak(state, position.realizedPnlSol);
  await saveState(state);

  await deleteOpenPosition(position.mint);
}

function updateStreak(
  state: PaperState,
  pnlSol: number
): void {
  if (pnlSol < 0) {
    state.consecutiveLosses += 1;
  } else {
    state.consecutiveLosses = 0;
  }
}

export async function getOpenPositions(): Promise<
  OpenPosition[]
> {
  const positions = await loadOpenPositions();
  return Array.from(positions.values());
}
