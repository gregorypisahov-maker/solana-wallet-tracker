export type IntelligenceMode = "off" | "shadow" | "advisory" | "enforce";

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function modeEnv(): IntelligenceMode {
  const value = String(process.env.HELIUS_INTELLIGENCE_MODE || "off").toLowerCase();
  return value === "shadow" || value === "advisory" || value === "enforce" ? value : "off";
}

export const intelligenceConfig = {
  mode: modeEnv(),
  pollMs: numberEnv("HELIUS_INTELLIGENCE_POLL_MS", 10_000, 2_000, 60_000),
  minimumAiScore: numberEnv("INTELLIGENCE_MIN_AI_SCORE", 78, 0, 100),
  maxCandidatesPerCycle: numberEnv("INTELLIGENCE_MAX_CANDIDATES_PER_CYCLE", 3, 1, 20),
  maxDeepAnalysesPerHour: numberEnv("INTELLIGENCE_MAX_DEEP_ANALYSES_PER_HOUR", 30, 1, 500),
  candidateMaxAgeMinutes: numberEnv("INTELLIGENCE_CANDIDATE_MAX_AGE_MINUTES", 5, 1, 60),
  cacheTtlSeconds: numberEnv("INTELLIGENCE_CACHE_TTL_SECONDS", 120, 15, 3600),
  requestTimeoutMs: numberEnv("HELIUS_REQUEST_TIMEOUT_MS", 8_000, 1_000, 30_000),
  monthlyCreditLimit: numberEnv("HELIUS_MONTHLY_CREDIT_LIMIT", 8_500_000, 1_000, 100_000_000),
  dailyCreditLimit: numberEnv("HELIUS_DAILY_CREDIT_LIMIT", 275_000, 100, 10_000_000),
  hourlyCreditLimit: numberEnv("HELIUS_HOURLY_CREDIT_LIMIT", 12_000, 10, 1_000_000),
  warnRatio: numberEnv("HELIUS_CREDIT_WARN_RATIO", 0.8, 0.5, 0.99),
  reduceRatio: numberEnv("HELIUS_CREDIT_REDUCE_RATIO", 0.9, 0.6, 0.995),
  stopRatio: numberEnv("HELIUS_CREDIT_STOP_RATIO", 0.95, 0.7, 1),
} as const;
