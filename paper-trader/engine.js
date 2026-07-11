// engine.js
// The core simulator. No real funds, no real transactions — every "buy" and
// "sell" here is a logged number. This is meant to answer one question
// honestly: if you'd traded every qualifying alert with these exact rules,
// would you have made money?

const config = require('./config');
const { evaluateEntry } = require('./entryFilter');
const { getPriceUsd } = require('./priceFeed');
const { appendTrade, loadState, saveState } = require('./storage');

const openPositions = new Map(); // mint -> position object

function resetDailyIfNeeded(state) {
  const today = new Date().toDateString();
  if (state.dailyResetDate !== today) {
    state.dailyResetDate = today;
    state.dailyStartBankrollSol = state.bankrollSol;
    state.halted = false;
    state.haltReason = null;
  }
  return state;
}

function isHalted(state) {
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

// Call this every time your Telegram bot would have sent an alert.
async function onAlert(alert) {
  let state = loadState();
  state = resetDailyIfNeeded(state);
  const haltCheck = isHalted(state);
  if (haltCheck.halted) {
    console.log(`[SKIP] ${alert.tokenSymbol}: trading halted — ${haltCheck.reason}`);
    saveState({ ...state, halted: true, haltReason: haltCheck.reason });
    return;
  }

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

  let entryPrice;
  try {
    const priceData = await getPriceUsd(alert.mint);
    entryPrice = priceData.priceUsd;
  } catch (err) {
    console.log(`[SKIP] ${alert.tokenSymbol}: price fetch failed — ${err.message}`);
    return;
  }

  const sizeSol = state.bankrollSol * config.position.sizePctPerTrade;
  const position = {
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

  openPositions.set(alert.mint, position);
  state.bankrollSol -= sizeSol;
  saveState(state);

  console.log(
    `[ENTER] ${alert.tokenSymbol} @ $${entryPrice} | size ${sizeSol.toFixed(3)} SOL | score ${alert.score}`
  );
}

// Call this on a timer (see index.js) to check open positions against
// current price and apply exit rules.
async function checkPositions() {
  let state = loadState();

  for (const [mint, pos] of openPositions.entries()) {
    let priceData;
    try {
      priceData = await getPriceUsd(mint);
    } catch (err) {
      console.log(`[WARN] ${pos.tokenSymbol}: price check failed — ${err.message}`);
      continue;
    }

    const currentMultiple = priceData.priceUsd / pos.entryPrice;
    pos.peakMultiple = Math.max(pos.peakMultiple, currentMultiple);
    const holdMinutes = (Date.now() - pos.entryTime) / 60000;

    // 1. Hard stop-loss
    if (currentMultiple <= 1 - config.exit.hardStopLossPct) {
      closePosition(pos, priceData.priceUsd, pos.remainingPct, 'hard_stop_loss', state);
      continue;
    }

    // 2. Max hold time
    if (holdMinutes >= config.exit.maxHoldMinutes) {
      closePosition(pos, priceData.priceUsd, pos.remainingPct, 'max_hold_time', state);
      continue;
    }

    // 3. Trailing stop (only once in profit)
    if (pos.peakMultiple > 1.0) {
      const trailFloor = pos.peakMultiple * (1 - config.exit.trailingStopPct);
      if (currentMultiple <= trailFloor) {
        closePosition(pos, priceData.priceUsd, pos.remainingPct, 'trailing_stop', state);
        continue;
      }
    }

    // 4. Take-profit ladder
    for (const rung of config.exit.takeProfitLadder) {
      const alreadyHit = pos.ladderHits.includes(rung.atMultiple);
      if (!alreadyHit && currentMultiple >= rung.atMultiple) {
        const sellPct = pos.remainingPct * rung.sellPct;
        pos.remainingPct -= sellPct;
        pos.ladderHits.push(rung.atMultiple);
        partialSell(pos, priceData.priceUsd, sellPct, `ladder_${rung.atMultiple}x`, state);
      }
    }

    if (pos.remainingPct <= 0.001) {
      openPositions.delete(mint);
    }
  }

  saveState(state);
}

function partialSell(pos, exitPrice, soldPct, reason, state) {
  const soldSizeSol = pos.sizeSol * soldPct;
  const multiple = exitPrice / pos.entryPrice;
  const proceedsSol = soldSizeSol * multiple;
  state.bankrollSol += proceedsSol;

  const pnlSol = proceedsSol - soldSizeSol;
  updateStreak(state, pnlSol);

  appendTrade({
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
  });

  console.log(
    `[SELL ${(soldPct * 100).toFixed(0)}%] ${pos.tokenSymbol} @ ${multiple.toFixed(2)}x (${reason}) | pnl ${pnlSol.toFixed(3)} SOL`
  );
}

function closePosition(pos, exitPrice, remainingPct, reason, state) {
  partialSell(pos, exitPrice, remainingPct, reason, state);
  openPositions.delete(pos.mint);
}

function updateStreak(state, pnlSol) {
  if (pnlSol < 0) {
    state.consecutiveLosses += 1;
  } else {
    state.consecutiveLosses = 0;
  }
}

function getOpenPositions() {
  return Array.from(openPositions.values());
}

module.exports = { onAlert, checkPositions, getOpenPositions };
