import "dotenv/config";
import { startAuditedWalletDiscoveryScheduler } from "./walletDiscoveryAudit";
import { startWalletIntelligenceScheduler } from "./walletIntelligence";
import { startShadowStrategyScheduler } from "./shadowStrategyScheduler";
import { startAdaptiveStrategyScheduler } from "../paper-trader/adaptiveStrategy";
import { startPaperAutoResumeScheduler } from "./paperAutoResume";

async function bootstrap(): Promise<void> {
  startAuditedWalletDiscoveryScheduler();
  startWalletIntelligenceScheduler();
  startAdaptiveStrategyScheduler();
  startShadowStrategyScheduler();
  startPaperAutoResumeScheduler();
  await import("./monitor");
}

bootstrap().catch((error) => {
  console.error("[monitor-bootstrap] startup failed:", error);
  process.exit(1);
});
