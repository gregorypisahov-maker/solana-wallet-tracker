import "dotenv/config";
import { startMoonshotScanner } from "../paper-trader/moonshotScanner";

void startMoonshotScanner().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[moonshot-scanner] unexpected startup error contained: ${message}`);
  setInterval(() => undefined, 60_000);
});
