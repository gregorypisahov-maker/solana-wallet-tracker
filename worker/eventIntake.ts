export interface WalletSignatureEvent {
  walletAddress: string;
  signature: string;
  receivedAt: number;
}

export class SignatureDeduper {
  private readonly processedAt = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maximumEntries = 50_000
  ) {}

  has(key: string, nowMs = Date.now()): boolean {
    const timestamp = this.processedAt.get(key);

    if (timestamp === undefined) {
      return false;
    }

    if (nowMs - timestamp > this.ttlMs) {
      this.processedAt.delete(key);
      return false;
    }

    return true;
  }

  mark(key: string, nowMs = Date.now()): void {
    this.processedAt.set(key, nowMs);
    this.prune(nowMs);
  }

  prune(nowMs = Date.now()): void {
    for (const [key, timestamp] of this.processedAt) {
      if (nowMs - timestamp > this.ttlMs) {
        this.processedAt.delete(key);
      }
    }

    while (this.processedAt.size > this.maximumEntries) {
      const oldestKey = this.processedAt.keys().next().value as
        | string
        | undefined;

      if (!oldestKey) break;
      this.processedAt.delete(oldestKey);
    }
  }
}

export class SerialEventQueue<T> {
  private readonly items: Array<{ key: string; value: T }> = [];
  private readonly queuedKeys = new Set<string>();
  private draining = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly handler: (value: T) => Promise<void>,
    private readonly onError: (error: unknown, value: T) => void,
    private readonly onDepthChange: (depth: number) => void = () => undefined
  ) {}

  get depth(): number {
    return this.items.length + (this.draining ? 1 : 0);
  }

  enqueue(key: string, value: T): boolean {
    if (this.queuedKeys.has(key)) {
      return false;
    }

    this.queuedKeys.add(key);
    this.items.push({ key, value });
    this.onDepthChange(this.depth);
    void this.drain();
    return true;
  }

  async whenIdle(): Promise<void> {
    if (!this.draining && this.items.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;

        try {
          await this.handler(item.value);
        } catch (error) {
          this.onError(error, item.value);
        } finally {
          this.queuedKeys.delete(item.key);
          this.onDepthChange(this.depth);
        }
      }
    } finally {
      this.draining = false;
      this.onDepthChange(0);

      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) resolve();

      // An enqueue can race with the final empty check above.
      if (this.items.length > 0) {
        void this.drain();
      }
    }
  }
}

export function signatureEventKey(
  walletAddress: string,
  signature: string
): string {
  return `${walletAddress}:${signature}`;
}
