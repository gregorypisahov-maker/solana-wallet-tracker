export interface ScoreInputs {
  walletsCount: number;
  liquidityUsd: number | null;
  marketCap: number | null;
  holders: number | null;
  holdersPrev: number | null;
  dumpDetected: boolean;
  scalpDetected: boolean;
}

export function computeScore(inputs: ScoreInputs): number {
  let score = 0;

  score += Math.min(inputs.walletsCount * 12, 45);

  const liq = inputs.liquidityUsd ?? 0;
  const mc = inputs.marketCap ?? 0;

  if (liq >= 100_000) score += 20;
  else if (liq >= 50_000) score += 15;
  else if (liq >= 25_000) score += 10;
  else if (liq >= 10_000) score += 5;
  else score -= 15;

  if (mc >= 50_000 && mc <= 300_000) score += 20;
  else if (mc > 300_000 && mc <= 1_000_000) score += 12;
  else if (mc > 1_000_000 && mc <= 5_000_000) score += 5;
  else if (mc < 25_000) score -= 10;

  if (
    inputs.holders !== null &&
    inputs.holdersPrev !== null &&
    inputs.holders > inputs.holdersPrev
  ) {
    score += 10;
  }

  if (inputs.dumpDetected) score -= 30;
  if (inputs.scalpDetected) score -= 25;

  return Math.max(0, Math.min(100, Math.round(score)));
}
