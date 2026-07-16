import "dotenv/config";
import { startWalletDiscoveryScheduler } from "./walletDiscovery";

async function main(): Promise<void> {
  startWalletDiscoveryScheduler();
  await import("./monitor");
}

main().catch((error) => {
  console.error("[monitor-bootstrap] Fatal startup error:", error);
  process.exit(1);
});
