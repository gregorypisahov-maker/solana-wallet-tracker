import "dotenv/config";
import { startMoonshotScanner } from "../paper-trader/moonshotScanner";

// Emergency fail-closed lock. The current provider subscription can report a
// local subscription before the remote WebSocket accepts logsSubscribe. Keep
// Moonshot observation disabled until the remote-ack validation is repaired.
const railwayRequestedEnabled = process.env.ENABLE_MOONSHOT_SCANNER;
process.env.ENABLE_MOONSHOT_SCANNER = "false";

console.log(
  `[moonshot-scanner] safety lock active; scanner forced disabled during WebSocket repair${
    railwayRequestedEnabled === "true" ? " (Railway requested true)" : ""
  }`,
);

// Keep the dedicated Railway service healthy in its intentionally idle state.
setInterval(() => undefined, 60_000);

void startMoonshotScanner().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[moonshot-scanner] unexpected startup error contained: ${message}`);
});
