const FREE_PLAN_SAFE_MAX_WALLETS = 5;

export function reduceWalletLimitForMonthlyBudget(options: {
  currentLimit: number;
  minimumLimit: number;
  projectedMonthlyCredits: number;
  targetMonthlyCredits: number;
}): number {
  const requestedLimit = Math.max(1, Math.floor(options.currentLimit));

  if (
    !Number.isFinite(options.projectedMonthlyCredits) ||
    !Number.isFinite(options.targetMonthlyCredits) ||
    options.projectedMonthlyCredits <= options.targetMonthlyCredits ||
    options.targetMonthlyCredits <= 0
  ) {
    return requestedLimit;
  }

  // Once projected usage is above budget, apply a Free-plan safety ceiling even
  // when Railway still has an older, larger MAX_HELIUS_WALLETS value. All other
  // active wallets remain covered by lower-cost reconciliation.
  const currentLimit = Math.min(FREE_PLAN_SAFE_MAX_WALLETS, requestedLimit);
  const minimumLimit = Math.max(
    1,
    Math.min(currentLimit, Math.floor(options.minimumLimit))
  );
  const proportionalLimit = Math.floor(
    requestedLimit *
      (options.targetMonthlyCredits / options.projectedMonthlyCredits)
  );

  return Math.max(
    minimumLimit,
    Math.min(currentLimit, requestedLimit - 1, proportionalLimit)
  );
}
