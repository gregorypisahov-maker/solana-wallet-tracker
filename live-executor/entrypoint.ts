import "dotenv/config";

async function main(): Promise<void> {
  process.env.LIVE_EXECUTOR_POLL_MS = "5000";

  const nativeSetInterval = global.setInterval;
  global.setInterval = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    nativeSetInterval(callback, delay === 5_000 ? 2_000 : delay, ...args)) as typeof global.setInterval;

  const { runLiveGuardian, startLiveGuardianMonitor } = await import("./liveGuardian");
  await runLiveGuardian();
  startLiveGuardianMonitor();

  const { startLiveExecutor } = await import("./liveExecutor");
  startLiveExecutor();
}

void main().catch((error) => {
  console.error("[live-executor] failed to start safely", error);
  process.exitCode = 1;
});
