export interface HeliusUsageSnapshot {
  periodStartedAt: string;
  capturedAt: string;
  signatureRequests: number;
  transactionRequests: number;
  webhookEvents: number;
  websocketNotifications: number;
  websocketBytes: number;
  rateLimitErrors: number;
  rpcFailures: number;
  storedTrades: number;
  duplicateEvents: number;
  maxQueueDepth: number;
}

type CounterName = Exclude<
  keyof HeliusUsageSnapshot,
  "periodStartedAt" | "capturedAt" | "maxQueueDepth"
>;

export class HeliusUsageTracker {
  private periodStartedAtMs: number;
  private readonly counters: Record<CounterName, number> = {
    signatureRequests: 0,
    transactionRequests: 0,
    webhookEvents: 0,
    websocketNotifications: 0,
    websocketBytes: 0,
    rateLimitErrors: 0,
    rpcFailures: 0,
    storedTrades: 0,
    duplicateEvents: 0,
  };
  private maxQueueDepth = 0;

  constructor(startedAtMs = Date.now()) {
    this.periodStartedAtMs = startedAtMs;
  }

  increment(counter: CounterName, amount = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.counters[counter] += amount;
  }

  observeQueueDepth(depth: number): void {
    if (Number.isFinite(depth)) {
      this.maxQueueDepth = Math.max(this.maxQueueDepth, Math.max(0, depth));
    }
  }

  snapshot(capturedAtMs = Date.now()): HeliusUsageSnapshot {
    return {
      periodStartedAt: new Date(this.periodStartedAtMs).toISOString(),
      capturedAt: new Date(capturedAtMs).toISOString(),
      ...this.counters,
      maxQueueDepth: this.maxQueueDepth,
    };
  }

  commit(snapshot: HeliusUsageSnapshot): void {
    for (const counter of Object.keys(this.counters) as CounterName[]) {
      this.counters[counter] = Math.max(
        0,
        this.counters[counter] - snapshot[counter]
      );
    }

    this.maxQueueDepth = 0;
    this.periodStartedAtMs = Date.parse(snapshot.capturedAt);
  }
}

export function estimateHeliusCredits(input: {
  signatureRequests: number;
  transactionRequests: number;
  webhookEvents?: number;
  websocketBytes: number;
}): number {
  const rpcCredits =
    Math.max(0, input.signatureRequests) +
    Math.max(0, input.transactionRequests) +
    Math.max(0, input.webhookEvents ?? 0);
  const websocketCredits =
    input.websocketBytes > 0
      ? Math.ceil(input.websocketBytes / 100_000) * 2
      : 0;

  return rpcCredits + websocketCredits;
}
