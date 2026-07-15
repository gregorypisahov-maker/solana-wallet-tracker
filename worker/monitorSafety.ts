export type Delay = (ms: number) => Promise<void>;

export function readBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

export function isFreshTimestamp(
  timestamp: Date,
  nowMs: number,
  maximumAgeMs: number,
  futureToleranceMs = 30_000
): boolean {
  const timestampMs = timestamp.getTime();

  if (!Number.isFinite(timestampMs)) {
    return false;
  }

  const ageMs = nowMs - timestampMs;
  return ageMs >= -futureToleranceMs && ageMs <= maximumAgeMs;
}

export function getRateLimitDelayMs(
  retryIndex: number,
  random: () => number = Math.random
): number {
  const exponentialMs = Math.min(2_000 * 2 ** retryIndex, 30_000);
  const jitterMs = Math.floor(Math.max(0, Math.min(1, random())) * 500);
  return exponentialMs + jitterMs;
}

/**
 * Spaces the start of every RPC request globally. It remains safe if wallet
 * concurrency is raised later because callers acquire their turn through one
 * shared promise queue.
 */
export class RpcPacer {
  private nextStartAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly minimumIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly delay: Delay = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async run<T>(request: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(async () => {
      const waitMs = Math.max(0, this.nextStartAt - this.now());

      if (waitMs > 0) {
        await this.delay(waitMs);
      }

      this.nextStartAt = this.now() + this.minimumIntervalMs;
      return request();
    });

    this.queue = turn.then(
      () => undefined,
      () => undefined
    );
    return turn;
  }
}
