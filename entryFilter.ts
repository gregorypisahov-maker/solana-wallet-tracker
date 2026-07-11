// paper-trader/engine.ts
// Core simulator. No real funds move — every "buy"/"sell" here is a logged
// number in Supabase. Sends Telegram notifications on entry and exit so you
// can see it working in the same chat as your real alerts.

import { config } from './config';
import { evaluateEntry } from './entryFilter';
import { getPriceUsd } from './priceFeed';
import {
  loadState,
  saveState,
  appendTrade,
  loadOpenPositions,
  saveOpenPosition,
  deleteOpenPosition,
} from './storage';
import { AlertInput, OpenPosition, PaperState, TradeRecord } from './types';
import { sendTelegramAlert } from '../lib/telegram';

function resetDailyIfNeeded(state: PaperState): PaperState {
  const today = new Date().toDateString();
  if (state.dailyResetDate !== today) {
    state.dailyResetDate = today;
    state.dailyStartBankrollSol = state.bankrollSol;
    state.halted = false;
    state.haltReason = null;
  }
  return state;
}

function isHalted(state: PaperState): { halted: boolean; reason: string | null } {
  const lossLimit = state.dailyStartBankrollSol * config.risk.dailyLossLimitPct;
  const currentLoss = state.dailyStartBankrollSol - state.bankrollSol;
  if (currentLoss >= lossLimit) {
    return { halted: true, reason: `daily loss limit hit (-${currentLoss.toFixed(3)} SOL)` };
  }
  if (state.consecutiveLosses >= config.risk.maxLossesInARow) {
    return { halted: true, reason: `${state.consecutiveLosses} consecutive losses` };
  }
  return { halted: false, reason: null };
}

async function notify(message: string): Promise<void> {
  try {
    await sendTelegramAlert(message);
  } catch (err) {
    console.error('[paper-trader] Telegram notify failed:', err);
  }
}

// Call this every time your worker would have sent a real alert.
export async function onAlert(alert: AlertInput): Promise<void> {
  let state = await loadState();
  state = resetDailyIfNeeded(state);
  const haltCheck = isHalted(state);
  if (haltCheck.halted) {
    console.log(`[SKIP] ${alert.tokenSymbol}: trading halted — ${haltCheck.reason}`);
    await saveState({ ...state, halted: true, haltReason: haltCheck.reason });
    return;
  }

  const openPositions = await loadOpenPositions();

  if (openPositions.size >= config.position.maxConcurrentPositions) {
    console.log(`[SKIP] ${alert.tokenSymbol}: max concurrent positions reached`);
    return;
  }
  if (openPositions.has(alert.mint)) {
    console.log(`[SKIP] ${alert.tokenSymbol}: already in a position for this mint`);
    return;
  }

  const evaluation = evaluateEntry(alert);
  if (!evaluation.pass) {
    console.log(`[REJECT] ${alert.tokenSymbol}: ${evaluation.reasons.join('; ')}`);
    return;
  }

  let entryPrice: number;
  try {
    const priceData = await getPriceUsd(alert.mint);
    entryPrice = priceData.priceUsd;
  } catch (err: any) {
    console.log(`[SKIP] ${alert.tokenSymbol}: price fetch failed — ${err.message}`);
    return;
  }

  const sizeSol = state.bankrollSol * config.position.sizePctPerTrade;
  const position: OpenPosition = {
    mint: alert.mint,
    tokenSymbol: alert.tokenSymbol,
    entryPrice,
    entryTime: Date.now(),
    sizeSol,
    remainingPct: 1.0,
    peakMultiple: 1.0,
    ladderHits: [],
    entryAlert: alert,
  };

  await saveOpenPosition(position);
  state.bankrollSol -= sizeSol;
  await saveState(state);

  console.log(
    `[ENTER] ${alert.tokenSymbol} @ $${entryPrice} | size ${sizeSol.toFixed(3)} SOL | score ${alert.score}`
  );

  if (config.telegram.notifyOnEntry) {
    await notify(
      `📝 [PAPER] Entered ${alert.tokenSymbol}\n` +
        `Size: ${sizeSol.toFixed(3)} SOL @ $${entryPrice}\n` +
        `Score: ${alert.score} | Wallets: ${alert.walletCount}\n` +
        `Mcap: $${alert.marketCapUsd.toLocaleString()} | Liq: $${alert.liquidityUsd.toLocaleString()}`
    );
  }
}

// Call this on a timer to check open positions against current price and
// apply exit rules (take-profit ladder, trailing stop, hard stop, max hold).
export async function checkPositions(): Promise<void> {
  const state = await loadState();
  const openPositions = await loadOpenPositions();

  for (const [mint, pos] of openPositions.entries()) {
    let priceData;
    try {
      priceData = await getPriceUsd(mint);
    } catch (err: any) {
      console.log(`[WARN] ${pos.tokenSymbol}: price check failed — ${err.message}`);
      continue;
    }

    const currentMultiple = priceData.priceUsd / pos.entryPrice;
    pos.peakMultiple = Math.max(pos.peakMultiple, currentMultiple);
    const holdMinutes = (Date.now() - pos.entryTime) / 60000;

    if (currentMultiple <= 1 - config.exit.hardStopLossPct) {
      await closePosition(pos, priceData.priceUsd, pos.remainingPct, 'hard_stop_loss', state);
      continue;
    }

    if (holdMinutes >= config.exit.maxHoldMinutes) {
      await closePosition(pos, priceData.priceUsd, pos.remainingPct, 'max_hold_time', state);
      continue;
    }

    if (pos.peakMultiple > 1.0) {
      const trailFloor = pos.peakMultiple * (1 - config.exit.trailingStopPct);
      if (currentMultiple <= trailFloor) {
        await closePosition(pos, priceData.priceUsd, pos.remainingPct, 'trailing_stop', state);
        continue;
      }
    }

    let touched = false;
    for (const rung of config.exit.takeProfitLadder) {
      const alreadyHit = pos.ladderHits.includes(rung.atMultiple);
      if (!alreadyHit && currentMultiple >= rung.atMultiple) {
        const sellPct = pos.remainingPct * rung.sellPct;
        pos.remainingPct -= sellPct;
        pos.ladderHits.push(rung.atMultiple);
        await partialSell(pos, priceData.priceUsd, sellPct, `ladder_${rung.atMultiple}x`, state);
        touched = true;
      }
    }

    if (pos.remainingPct <= 0.001) {
      await deleteOpenPosition(mint);
    } else if (touched) {
      await saveOpenPosition(pos);
    } else {
      // persist updated peakMultiple even if no sell happened
      await saveOpenPosition(pos);
    }
  }
}

async function partialSell(
  pos: OpenPosition,
  exitPrice: number,
  soldPct: number,
  reason: string,
  state: PaperState
): Promise<void> {
  const soldSizeSol = pos.sizeSol * soldPct;
  const multiple = exitPrice / pos.entryPrice;
  const proceedsSol = soldSizeSol * multiple;
  state.bankrollSol += proceedsSol;

  const pnlSol = proceedsSol - soldSizeSol;
  updateStreak(state, pnlSol);

  const trade: TradeRecord = {
    tokenSymbol: pos.tokenSymbol,
    mint: pos.mint,
    type: 'partial_sell',
    reason,
    entryPrice: pos.entryPrice,
    exitPrice,
    multiple: Number(multiple.toFixed(4)),
    soldPct: Number(soldPct.toFixed(4)),
    soldSizeSol: Number(soldSizeSol.toFixed(4)),
    proceedsSol: Number(proceedsSol.toFixed(4)),
    pnlSol: Number(pnlSol.toFixed(4)),
    holdMinutes: Number(((Date.now() - pos.entryTime) / 60000).toFixed(1)),
    timestamp: new Date().toISOString(),
    entryAlert: pos.entryAlert,
  };

  await appendTrade(trade);
  await saveState(state);

  console.log(
    `[SELL ${(soldPct * 100).toFixed(0)}%] ${pos.tokenSymbol} @ ${multiple.toFixed(2)}x (${reason}) | pnl ${pnlSol.toFixed(3)} SOL`
  );

  if (config.telegram.notifyOnExit) {
    const emoji = pnlSol >= 0 ? '✅' : '🔻';
    await notify(
      `${emoji} [PAPER] Sold ${(soldPct * 100).toFixed(0)}% of ${pos.tokenSymbol}\n` +
        `Reason: ${reason} | ${multiple.toFixed(2)}x\n` +
        `PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(3)} SOL\n` +
        `Held: ${trade.holdMinutes} min | Bankroll: ${state.bankrollSol.toFixed(3)} SOL`
    );
  }
}

async function closePosition(
  pos: OpenPosition,
  exitPrice: number,
  remainingPct: number,
  reason: string,
  state: PaperState
): Promise<void> {
  await partialSell(pos, exitPrice, remainingPct, reason, state);
  await deleteOpenPosition(pos.mint);
}

function updateStreak(state: PaperState, pnlSol: number): void {
  if (pnlSol < 0) {
    state.consecutiveLosses += 1;
  } else {
    state.consecutiveLosses = 0;
  }
}

export async function getOpenPositions(): Promise<OpenPosition[]> {
  const map = await loadOpenPositions();
  return Array.from(map.values());
}
