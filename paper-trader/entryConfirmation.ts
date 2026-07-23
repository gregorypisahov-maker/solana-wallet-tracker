export const ENTRY_CONFIRMATION_DELAY_MS = 10_000;
export const MAX_ENTRY_CONFIRMATION_DROP_PCT = 0.04;
export const MAX_ENTRY_CONFIRMATION_RISE_PCT = 0.06;

export interface EntryConfirmationEvaluation {
  pass: boolean;
  priceChangePct: number;
  reason: string | null;
}

export function evaluateEntryConfirmation(
  initialPriceUsd: number,
  confirmedPriceUsd: number
): EntryConfirmationEvaluation {
  if (!Number.isFinite(initialPriceUsd) || initialPriceUsd <= 0) {
    throw new Error(`Invalid initial confirmation price: ${initialPriceUsd}`);
  }

  if (!Number.isFinite(confirmedPriceUsd) || confirmedPriceUsd <= 0) {
    throw new Error(`Invalid confirmed entry price: ${confirmedPriceUsd}`);
  }

  const priceChangePct =
    (confirmedPriceUsd - initialPriceUsd) / initialPriceUsd;

  if (priceChangePct < -MAX_ENTRY_CONFIRMATION_DROP_PCT) {
    return {
      pass: false,
      priceChangePct,
      reason:
        `price fell ${(Math.abs(priceChangePct) * 100).toFixed(1)}% during ` +
        `the ${ENTRY_CONFIRMATION_DELAY_MS / 1000}s entry confirmation window`,
    };
  }

  if (priceChangePct > MAX_ENTRY_CONFIRMATION_RISE_PCT) {
    return {
      pass: false,
      priceChangePct,
      reason:
        `price rose ${(priceChangePct * 100).toFixed(1)}% during ` +
        `the ${ENTRY_CONFIRMATION_DELAY_MS / 1000}s entry confirmation window; ` +
        `entry would be chasing an active spike`,
    };
  }

  return { pass: true, priceChangePct, reason: null };
}

export async function waitForEntryConfirmation(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ENTRY_CONFIRMATION_DELAY_MS);
  });
}
