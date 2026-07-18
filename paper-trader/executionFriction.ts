export function applyEntryFriction(
  marketPrice: number,
  frictionPct: number
): number {
  return marketPrice * (1 + frictionPct);
}

export function applyExitFriction(
  marketPrice: number,
  frictionPct: number
): number {
  return marketPrice * (1 - frictionPct);
}
