import "dotenv/config";
import { startAuditedWalletDiscoveryScheduler } from "./walletDiscoveryAudit";
import { startWalletIntelligenceScheduler } from "./walletIntelligence";
import { startShadowStrategyScheduler } from "./shadowStrategyScheduler";
import { startAdaptiveStrategyScheduler } from "../paper-trader/adaptiveStrategy";
import { startPaperAutoResumeScheduler } from "./paperAutoResume";
import { startMomentumScalperScheduler } from "../paper-trader/momentumScalper";
import { startScalperShadowScheduler } from "../paper-trader/scalperShadow";
import { startLiveReadinessScheduler } from "../paper-trader/liveReadiness";

const WALLET_DISCOVERY_SERVICE = "Wallet Discovery & Monitor";
const TRADING_ENGINE_SERVICE = "Trading Engine";

function shouldStartWalletManagement(): boolean {
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim();
  return !serviceName || serviceName === WALLET_DISCOVERY_SERVICE;
}

function shouldStartTradingStrategies(): boolean {
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim();
  return !serviceName || serviceName === TRADING_ENGINE_SERVICE;
}

async function bootstrap(): Promise<void> {
  if (shouldStartWalletManagement()) {
    startAuditedWalletDiscoveryScheduler();
    startWalletIntelligenceScheduler();
  } else {
    console.log(`[monitor-bootstrap] wallet management disabled in ${process.env.RAILWAY_SERVICE_NAME}; owned by ${WALLET_DISCOVERY_SERVICE}`);
  }

  if (shouldStartTradingStrategies()) {
    console.log("[monitor-bootstrap] momentum strategy momentum_hardstop_blacklist_v6_2026_07_21");
    startAdaptiveStrategyScheduler();
    startShadowStrategyScheduler();
    startMomentumScalperScheduler();
    startScalperShadowScheduler();
    startLiveReadinessScheduler();
  } else {
    console.log(`[monitor-bootstrap] trading schedulers disabled in ${process.env.RAILWAY_SERVICE_NAME}; owned by ${TRADING_ENGINE_SERVICE}`);
  }

  startPaperAutoResumeScheduler();
  await import("./monitor");
}

bootstrap().catch((error) => {
  console.error("[monitor-bootstrap] startup failed:", error);
  process.exit(1);
});
