export const LIVE_READINESS_RULES = {
  minimumCompletedTrades: 100,
  minimumActiveDays: 45,
  minimumProfitFactor: 1.4,
  maximumDrawdownPct: 0.1,
  maximumSingleWinnerShare: 0.25,
} as const;

export interface ReadinessPosition {
  positionId: string;
  pnlSol: number;
  closedAt: string;
}

export interface LiveReadinessResult {
  ready: boolean;
  completedTrades: number;
  activeDays: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnlSol: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  largestWinnerShare: number;
  blockers: string[];
}

export function calculateLiveReadiness(input: {
  positions: ReadinessPosition[];
  startedAt: string;
  nowMs?: number;
  startingBankrollSol?: number;
}): LiveReadinessResult {
  const nowMs = input.nowMs ?? Date.now();
  const startingBankrollSol = input.startingBankrollSol ?? 10;
  const positions = [...input.positions].sort(
    (left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt)
  );
  const wins = positions.filter((position) => position.pnlSol > 0);
  const losses = positions.filter((position) => position.pnlSol < 0);
  const grossProfit = wins.reduce((sum, position) => sum + position.pnlSol, 0);
  const grossLoss = Math.abs(
    losses.reduce((sum, position) => sum + position.pnlSol, 0)
  );
  const realizedPnlSol = grossProfit - grossLoss;
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : null;
  const activeDays = Math.max(
    0,
    (nowMs - Date.parse(input.startedAt)) / 86_400_000
  );

  let equity = startingBankrollSol;
  let peak = equity;
  let maxDrawdownPct = 0;
  for (const position of positions) {
    equity += position.pnlSol;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak);
    }
  }

  const largestWinner = wins.reduce(
    (largest, position) => Math.max(largest, position.pnlSol),
    0
  );
  const largestWinnerShare = grossProfit > 0 ? largestWinner / grossProfit : 1;
  const blockers: string[] = [];

  if (positions.length < LIVE_READINESS_RULES.minimumCompletedTrades) {
    blockers.push("minimum_100_forward_trades_not_reached");
  }
  if (activeDays < LIVE_READINESS_RULES.minimumActiveDays) {
    blockers.push("minimum_45_forward_days_not_reached");
  }
  if (realizedPnlSol <= 0) blockers.push("forward_pnl_not_positive");
  if (
    profitFactor === null ||
    profitFactor < LIVE_READINESS_RULES.minimumProfitFactor
  ) {
    blockers.push("profit_factor_below_1_4");
  }
  if (maxDrawdownPct > LIVE_READINESS_RULES.maximumDrawdownPct) {
    blockers.push("maximum_drawdown_above_10_percent");
  }
  if (largestWinnerShare > LIVE_READINESS_RULES.maximumSingleWinnerShare) {
    blockers.push("results_too_concentrated_in_one_winner");
  }

  return {
    ready: blockers.length === 0,
    completedTrades: positions.length,
    activeDays,
    wins: wins.length,
    losses: losses.length,
    winRate: positions.length > 0 ? wins.length / positions.length : 0,
    realizedPnlSol,
    profitFactor,
    maxDrawdownPct,
    largestWinnerShare,
    blockers,
  };
}
