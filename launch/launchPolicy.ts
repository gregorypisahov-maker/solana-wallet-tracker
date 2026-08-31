export type LaunchPolicy = {
  name: string;
  symbol: string;
  totalSupply: string;
  creatorAllocationPct: number;
  liquidityAllocationPct: number;
  communityAllocationPct: number;
  marketingAllocationPct: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  liquidityLockDays: number;
};

export function validateLaunchPolicy(policy: LaunchPolicy): string[] {
  const errors: string[] = [];
  if (!policy.name.trim()) errors.push("name_required");
  if (!policy.symbol.trim()) errors.push("symbol_required");
  if (!/^[A-Za-z0-9]{2,12}$/.test(policy.symbol.trim())) errors.push("symbol_invalid");
  if (!/^\d+$/.test(policy.totalSupply)) errors.push("total_supply_must_be_integer_string");
  const allocations = [policy.creatorAllocationPct, policy.liquidityAllocationPct, policy.communityAllocationPct, policy.marketingAllocationPct];
  if (allocations.some((x) => !Number.isFinite(x) || x < 0)) errors.push("allocation_invalid");
  if (Math.abs(allocations.reduce((a, b) => a + b, 0) - 100) > 0.000001) errors.push("allocations_must_equal_100");
  if (!policy.mintAuthorityRevoked) errors.push("mint_authority_must_be_revoked_before_public_launch");
  if (!policy.freezeAuthorityRevoked) errors.push("freeze_authority_must_be_revoked_before_public_launch");
  if (!Number.isInteger(policy.liquidityLockDays) || policy.liquidityLockDays < 0) errors.push("liquidity_lock_days_invalid");
  return errors;
}

export function launchReadiness(policy: LaunchPolicy) {
  const errors = validateLaunchPolicy(policy);
  return { ready: errors.length === 0, errors, policyVersion: "1.0.0", checkedAt: new Date().toISOString() };
}
