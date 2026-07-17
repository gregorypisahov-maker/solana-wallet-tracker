import type { FilterCheck } from "./momentumScalperRules";

export const PULLBACK_RULES = {
  minimumCandles: 4,
  maximumCandleAgeSeconds: 120,
  minimumInitialMovePct: 1.5,
  maximumCurrentCandleGainPct: 1,
  minimumPullbackFromHighPct: 0.35,
  maximumPullbackFromHighPct: 3,
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
  checks: FilterCheck[];
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

function check(
  name: string,
  passed: boolean,
  actual: number | string | null,
  expected: string,
  reason: string
): FilterCheck {
  return { name, passed, actual, expected, reason: passed ? null : reason };
}

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
  const initialMovePct = finite(recentHighUsd) ? pct(recentHighUsd, firstOpenUsd) : Number.NaN;
  const pullbackFromHighPct = latest && recentHighUsd > 0
    ? ((recentHighUsd - latest.close) / recentHighUsd) * 100
    : Number.NaN;
  const recoveryFromLowPct = latest ? pct(latest.close, latest.low) : Number.NaN;
  const candleAgeSeconds = latest
    ? Math.max(0, nowMs / 1000 - latest.timestampSeconds)
    : Number.POSITIVE_INFINITY;

  const checks: FilterCheck[] = [
    check("pullback_candles_present", candles.length >= PULLBACK_RULES.minimumCandles, candles.length, `>= ${PULLBACK_RULES.minimumCandles}`, "pullback_candles_missing"),
    check("pullback_candles_finite", [currentCandleGainPct, initialMovePct, pullbackFromHighPct, recoveryFromLowPct, shortTermLevelUsd].every(finite), null, "all derived candle fields finite", "pullback_fields_missing_or_invalid"),
    check("pullback_candle_fresh", candleAgeSeconds <= PULLBACK_RULES.maximumCandleAgeSeconds, finite(candleAgeSeconds) ? candleAgeSeconds : null, `<= ${PULLBACK_RULES.maximumCandleAgeSeconds}s`, "pullback_candle_stale"),
    check("initial_move_confirmed", initialMovePct >= PULLBACK_RULES.minimumInitialMovePct, finite(initialMovePct) ? initialMovePct : null, `>= ${PULLBACK_RULES.minimumInitialMovePct}%`, "initial_move_not_confirmed"),
    check("current_1m_not_spiking", currentCandleGainPct <= PULLBACK_RULES.maximumCurrentCandleGainPct, finite(currentCandleGainPct) ? currentCandleGainPct : null, `<= ${PULLBACK_RULES.maximumCurrentCandleGainPct}%`, "current_one_minute_candle_still_spiking"),
    check("pullback_formed", pullbackFromHighPct >= PULLBACK_RULES.minimumPullbackFromHighPct, finite(pullbackFromHighPct) ? pullbackFromHighPct : null, `>= ${PULLBACK_RULES.minimumPullbackFromHighPct}%`, "pullback_not_formed"),
    check("pullback_not_too_deep", pullbackFromHighPct <= PULLBACK_RULES.maximumPullbackFromHighPct, finite(pullbackFromHighPct) ? pullbackFromHighPct : null, `<= ${PULLBACK_RULES.maximumPullbackFromHighPct}%`, "pullback_too_deep"),
    check("price_holds_short_term_level", Boolean(latest) && latest.close >= shortTermLevelUsd, latest?.close ?? null, `>= ${finite(shortTermLevelUsd) ? shortTermLevelUsd : "valid short-term level"}`, "price_not_holding_short_term_level"),
    check("price_recovered_from_1m_low", recoveryFromLowPct >= PULLBACK_RULES.minimumRecoveryFromLowPct, finite(recoveryFromLowPct) ? recoveryFromLowPct : null, `>= ${PULLBACK_RULES.minimumRecoveryFromLowPct}%`, "price_not_recovered_from_one_minute_low"),
  ];
  const reasons = [...new Set(checks.flatMap((item) => item.reason ? [item.reason] : []))];

  return {
    accepted: checks.every((item) => item.passed),
    reasons,
    checks,
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
