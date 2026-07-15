export function reduceWalletLimitForMonthlyBudget(options: {
  currentLimit: number;
  minimumLimit: number;
  projectedMonthlyCredits: number;
  targetMonthlyCredits: number;
}): number {
  const currentLimit = Math.max(1, Math.floor(options.currentLimit));
  const minimumLimit = Math.max(
    1,
    Math.min(currentLimit, Math.floor(options.minimumLimit))
  );

  if (
    !Number.isFinite(options.projectedMonthlyCredits) ||
    !Number.isFinite(options.targetMonthlyCredits) ||
    options.projectedMonthlyCredits <= options.targetMonthlyCredits ||
    options.targetMonthlyCredits <= 0
  ) {
    return currentLimit;
  }

  const proportionalLimit = Math.floor(
    currentLimit *
      (options.targetMonthlyCredits / options.projectedMonthlyCredits)
  );

  return Math.max(
    minimumLimit,
    Math.min(currentLimit - 1, proportionalLimit)
  );
}
