export interface HeliusWalletSelection {
  selected: string[];
  core: string[];
  rotating: string[];
  rotationSlot: number;
  rotationSlots: number;
}

/**
 * Keep the strongest paper-evidence wallets online continuously and rotate the
 * remaining webhook capacity through the exploration pool. This bounds Helius
 * event volume without permanently starving newer wallets of training data.
 */
export function selectHeliusWallets(options: {
  addresses: string[];
  trustScores: ReadonlyMap<string, number>;
  limit: number;
  coreCount: number;
  rotationHours: number;
  nowMs?: number;
}): HeliusWalletSelection {
  const unique = [...new Set(options.addresses)].sort((left, right) => {
    const scoreDifference =
      (options.trustScores.get(right) ?? 0) -
      (options.trustScores.get(left) ?? 0);
    return scoreDifference || left.localeCompare(right);
  });
  const limit = Math.max(1, Math.min(unique.length, Math.floor(options.limit)));
  const coreCount = Math.max(
    0,
    Math.min(limit, Math.floor(options.coreCount))
  );
  const core = unique.slice(0, coreCount);
  const explorationPool = unique.slice(coreCount);
  const rotatingCapacity = Math.max(0, limit - core.length);

  if (rotatingCapacity === 0 || explorationPool.length === 0) {
    return {
      selected: unique.slice(0, limit),
      core,
      rotating: [],
      rotationSlot: 0,
      rotationSlots: 1,
    };
  }

  const rotationSlots = Math.max(
    1,
    Math.ceil(explorationPool.length / rotatingCapacity)
  );
  const slotDurationMs = Math.max(1, options.rotationHours) * 3_600_000;
  const rotationSlot =
    Math.floor((options.nowMs ?? Date.now()) / slotDurationMs) % rotationSlots;
  const rotating: string[] = [];
  const start = rotationSlot * rotatingCapacity;
  for (
    let offset = 0;
    offset < rotatingCapacity && offset < explorationPool.length;
    offset += 1
  ) {
    rotating.push(explorationPool[(start + offset) % explorationPool.length]);
  }

  return {
    selected: [...core, ...rotating],
    core,
    rotating,
    rotationSlot,
    rotationSlots,
  };
}
