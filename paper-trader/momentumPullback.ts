export const PULLBACK_RULES = {
  minimumCandles: 4,
  maximumCandleAgeSeconds: 120,
  minimumInitialMovePct: 1.5,
  maximumCurrentCandleGainPct: 1.0,
  minimumPullbackFromHighPct: 0.35,
  maximumPullbackFromHighPct: 3.0,
  minimumRecoveryFromLowPct: 0.4,
} as const;

export type MinuteCandle = {
  timestampSeconds: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

export type PullbackEvaluation = {
  accepted: boolean;
  reasons: string[];
  snapshot: {
    candleCount: number;
    currentCandleGainPct: number | null;
    initialMovePct: number | null;
    pullbackFromHighPct: number | null;
    recoveryFromLowPct: number | null;
    shortTermLevelUsd: number | null;
    currentCloseUsd: number | null;
    recentHighUsd: number | null;
    latestCandleTimestampSeconds: number | null;
  };
};

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const pct = (to: number, from: number): number =>
  from > 0 ? ((to / from) - 1) * 100 : Number.NaN;

export function parseGeckoMinuteCandles(body: unknown): MinuteCandle[] {
  const rows = (body as any)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) return [];

  return rows
    .flatMap((row: unknown) => {
      if (!Array.isArray(row) || row.length < 6) return [];
      const [timestampSeconds, open, high, low, close, volumeUsd] = row.map(Number);
      const valid =
        [timestampSeconds, open, high, low, close, volumeUsd].every(finite) &&
        timestampSeconds > 0 &&
        open > 0 &&
        high >= Math.max(open, close) &&
        low > 0 &&
        low <= Math.min(open, close) &&
        volumeUsd >= 0;
      return valid
        ? [{ timestampSeconds, open, high, low, close, volumeUsd }]
        : [];
    })
    .sort((left, right) => left.timestampSeconds - right.timestampSeconds);
}

export function evaluateMomentumPullback(
  allCandles: MinuteCandle[],
  nowMs = Date.now()
): PullbackEvaluation {
  const candles = [...allCandles]
    .sort((left, right) => left.timestampSeconds - right.timestampSeconds)
    .slice(-PULLBACK_RULES.minimumCandles);
  const latest = candles[candles.length - 1];
  const prior = candles.slice(0, -1);
  const recentHighUsd = candles.length
    ? Math.max(...candles.map((candle) => candle.high))
    : Number.NaN;
  const firstOpenUsd = candles[0]?.open ?? Number.NaN;
  const shortTermLevelUsd = prior.length
    ? prior.reduce((sum, candle) => sum + candle.close, 0) / prior.length
    : Number.NaN;
  const currentCandleGainPct = latest ? pct(latest.close, latest.open) : Number.NaN;
  const initialMovePct = finite(recentHighUsd)
    ? pct(recentHighUsd, firstOpenUsd)
    : Number.NaN;
  const pullbackFromHighPct = latest && recentHighUsd > 0
    ? ((recentHighUsd - latest.close) / recentHighUsd) * 100
    : Number.NaN;
  const recoveryFromLowPct = latest ? pct(latest.close, latest.low) : Number.NaN;
  const candleAgeSeconds = latest
    ? Math.max(0, nowMs / 1000 - latest.timestampSeconds)
    : Number.POSITIVE_INFINITY;

  const reasons: string[] = [];
  if (candles.length < PULLBACK_RULES.minimumCandles) reasons.push("pullback_candles_missing");
  if (![currentCandleGainPct, initialMovePct, pullbackFromHighPct, recoveryFromLowPct, shortTermLevelUsd].every(finite)) reasons.push("pullback_fields_missing_or_invalid");
  if (candleAgeSeconds > PULLBACK_RULES.maximumCandleAgeSeconds) reasons.push("pullback_candle_stale");
  if (initialMovePct < PULLBACK_RULES.minimumInitialMovePct) reasons.push("initial_move_not_confirmed");
  if (currentCandleGainPct > PULLBACK_RULES.maximumCurrentCandleGainPct) reasons.push("current_one_minute_candle_still_spiking");
  if (pullbackFromHighPct < PULLBACK_RULES.minimumPullbackFromHighPct) reasons.push("pullback_not_formed");
  if (pullbackFromHighPct > PULLBACK_RULES.maximumPullbackFromHighPct) reasons.push("pullback_too_deep");
  if (!latest || latest.close < shortTermLevelUsd) reasons.push("price_not_holding_short_term_level");
  if (recoveryFromLowPct < PULLBACK_RULES.minimumRecoveryFromLowPct) reasons.push("price_not_recovered_from_one_minute_low");

  return {
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)],
    snapshot: {
      candleCount: candles.length,
      currentCandleGainPct: finite(currentCandleGainPct) ? currentCandleGainPct : null,
      initialMovePct: finite(initialMovePct) ? initialMovePct : null,
      pullbackFromHighPct: finite(pullbackFromHighPct) ? pullbackFromHighPct : null,
      recoveryFromLowPct: finite(recoveryFromLowPct) ? recoveryFromLowPct : null,
      shortTermLevelUsd: finite(shortTermLevelUsd) ? shortTermLevelUsd : null,
      currentCloseUsd: latest?.close ?? null,
      recentHighUsd: finite(recentHighUsd) ? recentHighUsd : null,
      latestCandleTimestampSeconds: latest?.timestampSeconds ?? null,
    },
  };
}
