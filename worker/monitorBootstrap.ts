import "dotenv/config";
import { startAuditedWalletDiscoveryScheduler } from "./walletDiscoveryAudit";

async function bootstrap(): Promise<void> {
  startAuditedWalletDiscoveryScheduler();
  await import("./monitor");
}

bootstrap().catch((error) => {
  console.error("[monitor-bootstrap] startup failed:", error);
  process.exit(1);
});
