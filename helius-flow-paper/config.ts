function numberEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
}

export const flowPaperConfig = {
  enabled: process.env.HELIUS_FLOW_PAPER_ENABLED === "true",
  service: "helius_flow_paper_v1",
  pollMs: numberEnv("HELIUS_FLOW_PAPER_POLL_MS", 5_000, 2_000, 60_000),
  positionCheckMs: numberEnv("HELIUS_FLOW_POSITION_CHECK_MS", 6_000, 2_000, 60_000),
  snapshotMaxAgeSeconds: numberEnv("HELIUS_FLOW_SNAPSHOT_MAX_AGE_SECONDS", 120, 15, 600),
  minimumSourceScore: numberEnv("HELIUS_FLOW_MIN_SOURCE_SCORE", 80, 60, 100),
  positionSizeSol: numberEnv("HELIUS_FLOW_POSITION_SIZE_SOL", 0.1, 0.01, 5),
  maxOpenPositions: Math.floor(numberEnv("HELIUS_FLOW_MAX_OPEN_POSITIONS", 1, 1, 10)),
  hardStopPct: -numberEnv("HELIUS_FLOW_HARD_STOP_PCT", 6, 1, 30),
  takeProfitPct: numberEnv("HELIUS_FLOW_TAKE_PROFIT_PCT", 10, 1, 100),
  trailArmPct: numberEnv("HELIUS_FLOW_TRAIL_ARM_PCT", 6, 1, 100),
  trailDistancePct: numberEnv("HELIUS_FLOW_TRAIL_DISTANCE_PCT", 4, 1, 30),
  maxHoldMinutes: numberEnv("HELIUS_FLOW_MAX_HOLD_MINUTES", 45, 1, 240),
  cooldownMinutes: numberEnv("HELIUS_FLOW_COOLDOWN_MINUTES", 120, 1, 1440),
  slippageBps: Math.floor(numberEnv("HELIUS_FLOW_SLIPPAGE_BPS", 100, 10, 200)),
};
