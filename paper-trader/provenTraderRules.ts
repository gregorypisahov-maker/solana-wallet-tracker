export const PROVEN_TRADER_RULES = {
  minClosedTrades: 8,
  minDistinctClosedTokens: 3,
  minWinRate: 0.55,
  // Recent profitable wallets cluster around PF 1.3-1.5. Keep positive PnL,
  // sample-depth and drawdown requirements so this does not admit noisy churners.
  minProfitFactor: 1.3,
  minRealizedPnlSol: 0.1,
  maxDrawdownToGrossProfit: 0.75,
  // A lower hit rate can still have strong positive expectancy when winners
  // are larger than losses. This exception requires a deeper sample and the
  // same validated PF/PnL floor as the profitable-wallet cohort.
  asymmetricMinClosedTrades: 12,
  asymmetricMinProfitFactor: 1.3,
  asymmetricMinRealizedPnlSol: 0.1,
} as const;

export interface ProvenTraderSignalProfile {
  profileVersion: number;
  closedTrades: number;
  distinctClosedTokens: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnlSol: number;
  grossProfitSol: number;
  grossLossSol: number;
  profitFactor: number | null;
  maxDrawdownSol: number;
  maxDrawdownToGrossProfit: number;
  eligible: boolean;
}

export function provenTraderProfileReasons(
  profile: ProvenTraderSignalProfile
): string[] {
  const reasons: string[] = [];

  if (profile.closedTrades < PROVEN_TRADER_RULES.minClosedTrades) {
    reasons.push(
      `leader_closed_trades_below_${PROVEN_TRADER_RULES.minClosedTrades}`
    );
  }
  if (
    profile.distinctClosedTokens <
    PROVEN_TRADER_RULES.minDistinctClosedTokens
  ) {
    reasons.push(
      `leader_distinct_tokens_below_${PROVEN_TRADER_RULES.minDistinctClosedTokens}`
    );
  }
  const hasHighWinRate = profile.winRate >= PROVEN_TRADER_RULES.minWinRate;
  const hasStrongAsymmetricExpectancy =
    profile.closedTrades >= PROVEN_TRADER_RULES.asymmetricMinClosedTrades &&
    profile.profitFactor !== null &&
    profile.profitFactor >= PROVEN_TRADER_RULES.asymmetricMinProfitFactor &&
    profile.realizedPnlSol >=
      PROVEN_TRADER_RULES.asymmetricMinRealizedPnlSol;
  if (!hasHighWinRate && !hasStrongAsymmetricExpectancy) {
    reasons.push("leader_win_rate_or_expectancy_too_low");
  }
  if (
    profile.profitFactor === null ||
    profile.profitFactor < PROVEN_TRADER_RULES.minProfitFactor
  ) {
    reasons.push("leader_profit_factor_too_low");
  }
  if (profile.realizedPnlSol < PROVEN_TRADER_RULES.minRealizedPnlSol) {
    reasons.push("leader_realized_pnl_too_low");
  }
  if (
    profile.maxDrawdownToGrossProfit >
    PROVEN_TRADER_RULES.maxDrawdownToGrossProfit
  ) {
    reasons.push("leader_drawdown_too_high");
  }

  return reasons;
}

export function isProvenTraderSignalProfile(
  value: unknown
): value is ProvenTraderSignalProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  const numericFields = [
    "profileVersion",
    "closedTrades",
    "distinctClosedTokens",
    "wins",
    "losses",
    "winRate",
    "realizedPnlSol",
    "grossProfitSol",
    "grossLossSol",
    "maxDrawdownSol",
    "maxDrawdownToGrossProfit",
  ];

  if (
    numericFields.some(
      (field) => !Number.isFinite(Number(profile[field]))
    )
  ) {
    return false;
  }
  if (
    profile.profitFactor !== null &&
    !Number.isFinite(Number(profile.profitFactor))
  ) {
    return false;
  }

  const normalized = profile as unknown as ProvenTraderSignalProfile;
  return (
    normalized.profileVersion >= 1 &&
    provenTraderProfileReasons(normalized).length === 0
  );
}
