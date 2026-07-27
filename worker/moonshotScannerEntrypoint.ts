import "dotenv/config";
import { startMoonshotScanner } from "../paper-trader/moonshotScanner";

// A dedicated scanner service must remain healthy even when disabled or
// misconfigured. This timer prevents Railway from treating a safe idle state as
// a crash. The process imports no paper or live execution module.
setInterval(() => undefined, 60_000);

void startMoonshotScanner().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[moonshot-scanner] unexpected startup error contained: ${message}`);
});
