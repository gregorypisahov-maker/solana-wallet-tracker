import "dotenv/config";
import { startMoonshotScanner } from "../paper-trader/moonshotScanner";

void startMoonshotScanner().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[moonshot-scanner] unexpected startup error contained: ${message}`);

  // Keep the dedicated Railway process alive in a safe idle state instead of
  // entering a crash/restart loop. Scanner failures must never affect the paper
  // Trading Engine, and this process has no trade execution imports.
  setInterval(() => undefined, 60_000);
});
