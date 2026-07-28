export type LiveEntryTimestampField =
  | "source_opened_at"
  | "decision_at"
  | "created_at";

type LiveEntryTimingSignal = {
  created_at: string;
  metadata: Record<string, unknown> | null;
};

export type LiveEntryTimingResult = {
  field: LiveEntryTimestampField | null;
  timestamp: string | null;
  rawAgeMs: number | null;
  sourceAgeMs: number | null;
  valid: boolean;
  tooFarInFuture: boolean;
  expired: boolean;
};

export function evaluateLiveEntryTiming(
  signal: LiveEntryTimingSignal,
  maximumAgeMs: number,
  nowMs = Date.now(),
  clockSkewToleranceMs = 5_000
): LiveEntryTimingResult {
  const candidates: Array<[LiveEntryTimestampField, unknown]> = [
    ["source_opened_at", signal.metadata?.source_opened_at],
    ["decision_at", signal.metadata?.decision_at],
    ["created_at", signal.created_at],
  ];

  for (const [field, candidate] of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const parsedAtMs = Date.parse(candidate);
    if (!Number.isFinite(parsedAtMs)) continue;

    const rawAgeMs = nowMs - parsedAtMs;
    const tooFarInFuture = rawAgeMs < -clockSkewToleranceMs;
    const sourceAgeMs =
      rawAgeMs < 0 && !tooFarInFuture ? 0 : rawAgeMs;
    return {
      field,
      timestamp: candidate,
      rawAgeMs,
      sourceAgeMs,
      valid: true,
      tooFarInFuture,
      expired: sourceAgeMs > maximumAgeMs,
    };
  }

  return {
    field: null,
    timestamp: null,
    rawAgeMs: null,
    sourceAgeMs: null,
    valid: false,
    tooFarInFuture: false,
    expired: false,
  };
}
