import { config } from "./config";

export type SharedPaperPosition = {
  entryPrice: number;
  entryTime: number;
  remainingPct: number;
  peakMultiple: number;
  ladderHits: number[];
};

export type SharedExitAction = {
  soldPct: number;
  reason: string;
  terminal: boolean;
};

export type SharedExitDecision = {
  currentMultiple: number;
  peakMultiple: number;
  actions: SharedExitAction[];
};

/**
 * Pure exit evaluator backed by the same central config used by the main
 * Sentinel paper engine. Shadow strategies call this rather than owning a
 * separate set of exit thresholds.
 */
export function evaluateSharedPaperExit(
  position: SharedPaperPosition,
  currentPrice: number,
  nowMs = Date.now()
): SharedExitDecision {
  const currentMultiple = currentPrice / position.entryPrice;
  const peakMultiple = Math.max(position.peakMultiple, currentMultiple);
  const holdMinutes = (nowMs - position.entryTime) / 60_000;

  if (currentMultiple <= 1 - config.exit.hardStopLossPct) {
    return {
      currentMultiple,
      peakMultiple,
      actions: [{ soldPct: position.remainingPct, reason: "hard_stop_loss", terminal: true }],
    };
  }

  if (
    peakMultiple >= config.exit.breakEvenActivationMultiple &&
    currentMultiple <= 1
  ) {
    return {
      currentMultiple,
      peakMultiple,
      actions: [{ soldPct: position.remainingPct, reason: "break_even_protection", terminal: true }],
    };
  }

  if (holdMinutes >= config.exit.maxHoldMinutes) {
    return {
      currentMultiple,
      peakMultiple,
      actions: [{ soldPct: position.remainingPct, reason: "max_hold_time", terminal: true }],
    };
  }

  if (peakMultiple >= config.exit.trailingActivationMultiple) {
    const trailingFloor = peakMultiple * (1 - config.exit.trailingStopPct);
    if (currentMultiple <= trailingFloor) {
      return {
        currentMultiple,
        peakMultiple,
        actions: [{ soldPct: position.remainingPct, reason: "trailing_stop", terminal: true }],
      };
    }
  }

  let remaining = position.remainingPct;
  const actions: SharedExitAction[] = [];
  for (const rung of config.exit.takeProfitLadder) {
    if (position.ladderHits.includes(rung.atMultiple)) continue;
    if (currentMultiple < rung.atMultiple) continue;

    const soldPct = remaining * rung.sellPct;
    remaining -= soldPct;
    actions.push({
      soldPct,
      reason: `ladder_${rung.atMultiple}x`,
      terminal: remaining <= 0.001,
    });
  }

  return { currentMultiple, peakMultiple, actions };
}
