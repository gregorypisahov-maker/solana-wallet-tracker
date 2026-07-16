import "dotenv/config";
import { startAuditedWalletDiscoveryScheduler } from "./walletDiscoveryAudit";
import { startWalletIntelligenceScheduler } from "./walletIntelligence";
import { startAdaptiveStrategyScheduler } from "../paper-trader/adaptiveStrategy";

async function bootstrap(): Promise<void> {
  startAuditedWalletDiscoveryScheduler();
  startWalletIntelligenceScheduler();
  startAdaptiveStrategyScheduler();
  await import("./monitor");
}

bootstrap().catch((error) => {
  console.error("[monitor-bootstrap] startup failed:", error);
  process.exit(1);
});
