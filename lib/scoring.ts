export interface ScoreInputs {
  walletsCount: number;       // distinct smart wallets that bought (excluding scalps)
  liquidityUsd: number | null;
  marketCap: number | null;
  holders: number | null;
  holdersPrev: number | null;
  dumpDetected: boolean;      // dev/top holder dumping
  scalpDetected: boolean;     // a buy+sell inside the scalp window was seen for this token
}

/**
 * Scoring rules, exactly as specified:
 *  +2 per smart wallet buying
 *  +1 if liquidity > $30K
 *  +1 if market cap is $100K–$5M
 *  +1 if holders are increasing
 *  -3 if dev/top holders are dumping
 *  -3 if buy/sell happened in under 5 minutes (scalp)
 */
export function computeScore(inputs: ScoreInputs): number {
  let score = 0;

  score += inputs.walletsCount * 2;

  if (inputs.liquidityUsd !== null && inputs.liquidityUsd > 30_000) {
    score += 1;
  }

  if (
    inputs.marketCap !== null &&
    inputs.marketCap >= 100_000 &&
    inputs.marketCap <= 5_000_000
  ) {
    score += 1;
  }

  if (
    inputs.holders !== null &&
    inputs.holdersPrev !== null &&
    inputs.holders > inputs.holdersPrev
  ) {
    score += 1;
  }

  if (inputs.dumpDetected) {
    score -= 3;
  }

  if (inputs.scalpDetected) {
    score -= 3;
  }

  return score;
}
