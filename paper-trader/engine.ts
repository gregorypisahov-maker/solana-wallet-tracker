// paper-trader/engine.ts
// Paper-trading simulator.
// No real funds are moved. All positions and trades are simulated.

import { config } from "./config";
import { evaluateEntry } from "./entryFilter";
import { getPriceUsd } from "./priceFeed";
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

function resetDailyIfNeeded(state: PaperState): PaperState {
  const today = new Date().toDateString();

  if (state.dailyResetDate !== today) {
    state.dailyResetDate = today;
    state.dailyStartBankrollSol = state.bankrollSol;
    state.consecutiveLosses = 0;
    state.halted = false;
    state.haltReason = null;
  }

  return state;
}

/**
 * Calculates available bankroll plus the original cost basis still committed
 * to open positions.
 *
 * This prevents an opened position from being incorrectly counted as a loss.
 */
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

function isHalted(
  state: PaperState,
  openPositions: Map<string, OpenPosition>
): { halted: boolean; reason: string | null } {
  const currentEquitySol = calculateCostBasisEquity(state, openPositions);
  const lossLimitSol =
    state.dailyStartBankrollSol * config.risk.dailyLossLimitPct;

  const currentLossSol =
    state.dailyStartBankrollSol - currentEquitySol;

  if (currentLossSol >= lossLimitSol) {
    return {
      halted: true,
      reason:
        `daily loss limit reached ` +
        `(-${currentLossSol.toFixed(3)} SOL)`,
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

async function notify(message: string): Promise<void> {
  try {
    await sendTelegramAlert(message);
  } catch (err) {
    console.error(
      "[paper-trader] Telegram notification failed:",
      err
    );
  }
}

async function notifySkipped(
  alert: AlertInput,
  reason: string
): Promise<void> {
  console.log(
    `[PAPER SKIP] ${alert.tokenSymbol}: ${reason}`
  );

  if (config.telegram.notifyOnReject) {
    await notify(
      `⏭️ <b>[PAPER] Trade skipped</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Reason: ${reason}`
    );
  }
}

async function notifyRejected(
  alert: AlertInput,
  reasons: string[]
): Promise<void> {
  const reasonText = reasons.join("\n• ");

  console.log(
    `[PAPER REJECT] ${alert.tokenSymbol}: ` +
      reasons.join("; ")
  );

  if (config.telegram.notifyOnReject) {
    await notify(
      `🟠 <b>[PAPER] Entry rejected</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Score: ${alert.score}\n` +
        `Wallets: ${alert.walletCount}\n\n` +
        `<b>Reasons:</b>\n• ${reasonText}`
    );
  }
}

// Called by worker/monitor.ts after a consensus alert is generated.
export async function onAlert(
  alert: AlertInput
): Promise<void> {
  let state = await loadState();
  state = resetDailyIfNeeded(state);

  const openPositions = await loadOpenPositions();
  const haltCheck = isHalted(state, openPositions);

  if (haltCheck.halted) {
    state.halted = true;
    state.haltReason = haltCheck.reason;

    await saveState(state);

    await notifySkipped(
      alert,
      `paper trading is halted: ${haltCheck.reason}`
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
    await notifySkipped(
      alert,
      `maximum of ${config.position.maxConcurrentPositions} open positions reached`
    );

    return;
  }

  if (openPositions.has(alert.mint)) {
    await notifySkipped(
      alert,
      "a paper position for this token is already open"
    );

    return;
  }

  const evaluation = evaluateEntry(alert);

  if (!evaluation.pass) {
    await notifyRejected(
      alert,
      evaluation.reasons
    );

    return;
  }

  let entryPrice: number;

  try {
    const priceData = await getPriceUsd(alert.mint);
    entryPrice = priceData.priceUsd;

    if (
      !Number.isFinite(entryPrice) ||
      entryPrice <= 0
    ) {
      throw new Error(
        `invalid price returned: ${entryPrice}`
      );
    }
  } catch (err: any) {
    const message =
      err instanceof Error
        ? err.message
        : String(err);

    await notifySkipped(
      alert,
      `price fetch failed: ${message}`
    );

    return;
  }

  const sizeSol =
    state.bankrollSol *
    config.position.sizePctPerTrade;

  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    await notifySkipped(
      alert,
      "calculated position size is zero or invalid"
    );

    return;
  }

  if (sizeSol > state.bankrollSol) {
    await notifySkipped(
      alert,
      "not enough simulated bankroll"
    );

    return;
  }

  const position: OpenPosition = {
    mint: alert.mint,
    tokenSymbol: alert.tokenSymbol,
    entryPrice,
    entryTime: Date.now(),
    sizeSol,
    remainingPct: 1,
    peakMultiple: 1,
    ladderHits: [],
    entryAlert: alert,
  };

  await saveOpenPosition(position);

  state.bankrollSol -= sizeSol;
  await saveState(state);

  console.log(
    `[PAPER ENTER] ${alert.tokenSymbol} ` +
      `@ $${entryPrice} | ` +
      `size ${sizeSol.toFixed(3)} SOL | ` +
      `score ${alert.score}`
  );

  if (config.telegram.notifyOnEntry) {
    await notify(
      `📝 <b>[PAPER] Position opened</b>\n\n` +
        `Token: <b>${alert.tokenSymbol}</b>\n` +
        `Size: ${sizeSol.toFixed(3)} SOL\n` +
        `Entry: $${entryPrice}\n` +
        `Score: ${alert.score}\n` +
        `Wallets: ${alert.walletCount}\n` +
        `Average buy: ${evaluation.avgBuyPerWallet.toFixed(2)} SOL\n` +
        `Market cap: $${Number(
          alert.marketCapUsd ?? 0
        ).toLocaleString()}\n` +
        `Liquidity: $${Number(
          alert.liquidityUsd ?? 0
        ).toLocaleString()}\n` +
        `Liq/MCap: ${(
          evaluation.liqToMcap * 100
        ).toFixed(1)}%`
    );
  }
}

// Checks all open paper positions for exits.
export async function checkPositions(): Promise<void> {
  const state = await loadState();
  const openPositions = await loadOpenPositions();

  for (const [mint, position] of openPositions.entries()) {
    let currentPrice: number;

    try {
      const priceData = await getPriceUsd(mint);
      currentPrice = priceData.priceUsd;

      if (
        !Number.isFinite(currentPrice) ||
        currentPrice <= 0
      ) {
        throw new Error(
          `invalid price returned: ${currentPrice}`
        );
      }
    } catch (err: any) {
      const message =
        err instanceof Error
          ? err.message
          : String(err);

      console.log(
        `[PAPER WARN] ${position.tokenSymbol}: ` +
          `price check failed — ${message}`
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
      (Date.now() - position.entryTime) / 60_000;

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

    if (position.peakMultiple > 1) {
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
      // Saves remaining percentage, ladder hits and peak price.
      await saveOpenPosition(position);
    }

    if (positionChanged) {
      console.log(
        `[PAPER UPDATE] ${position.tokenSymbol}: ` +
          `${(
            position.remainingPct * 100
          ).toFixed(1)}% remaining`
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
  updateStreak(state, pnlSol);

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
