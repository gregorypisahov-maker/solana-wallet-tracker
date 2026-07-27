import "dotenv/config";

async function main(): Promise<void> {
  if (!process.env.LIVE_EXECUTOR_POLL_MS) {
    process.env.LIVE_EXECUTOR_POLL_MS = "2000";
  }

  const { startLiveExecutor } = await import("./liveExecutor");
  startLiveExecutor();
}

void main().catch((error) => {
  console.error("[live-executor] failed to start", error);
  process.exitCode = 1;
});
