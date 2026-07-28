import "dotenv/config";

function isIntentionalGuardianHalt(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message === "hot_wallet_limit_exceeded" ||
    message === "guardian_wallet_health_failed" ||
    message.startsWith("boot_reconciliation_required:") ||
    message.startsWith("boot_position_balance_mismatch:")
  );
}

async function main(): Promise<void> {
  process.env.LIVE_EXECUTOR_POLL_MS = "5000";

  const nativeSetInterval = global.setInterval;
  global.setInterval = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    nativeSetInterval(callback, delay === 5_000 ? 2_000 : delay, ...args)) as typeof global.setInterval;

  const { runLiveGuardian, startLiveGuardianMonitor } = await import("./liveGuardian");

  try {
    await runLiveGuardian();
  } catch (error) {
    if (!isIntentionalGuardianHalt(error)) throw error;

    console.warn(
      "[live-executor] guardian halted live trading; service will remain healthy and idle",
      error instanceof Error ? error.message : String(error)
    );
    startLiveGuardianMonitor();
    return;
  }

  startLiveGuardianMonitor();

  const { startLiveExecutor } = await import("./liveExecutor");
  startLiveExecutor();
}

void main().catch((error) => {
  console.error("[live-executor] failed to start safely", error);
  process.exitCode = 1;
});
