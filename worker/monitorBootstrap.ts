import "dotenv/config";
import { startWalletIntelligenceScheduler } from "./walletIntelligence";
import { startShadowStrategyScheduler } from "./shadowStrategyScheduler";
import { startAdaptiveStrategyScheduler } from "../paper-trader/adaptiveStrategy";
import { startPaperAutoResumeScheduler } from "./paperAutoResume";
import { startMomentumScalperScheduler } from "../paper-trader/momentumScalper";
import { startScalperShadowScheduler } from "../paper-trader/scalperShadow";
import { startTieredEntryShadowScheduler } from "../paper-trader/tieredEntryShadow";
import { startTieredRecentSignalPump } from "../paper-trader/tieredRecentSignalPump";
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
  const ownsWalletMonitor = shouldStartWalletManagement();

  if (ownsWalletMonitor) {
    // Freeze automatic trial-wallet discovery while Helius credits are limited.
    // Existing proven wallets continue to be scored and monitored normally.
    console.log(
      "[monitor-bootstrap] automatic wallet discovery paused; monitoring existing proven wallets only"
    );
    startWalletIntelligenceScheduler();
  } else {
    console.log(
      `[monitor-bootstrap] wallet management disabled in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${WALLET_DISCOVERY_SERVICE}`
    );
  }

  if (shouldStartTradingStrategies()) {
    console.log(
      "[monitor-bootstrap] momentum strategy momentum_hardstop_blacklist_v6_2026_07_21"
    );
    startAdaptiveStrategyScheduler();
    startShadowStrategyScheduler();
    startMomentumScalperScheduler();
    startScalperShadowScheduler();
    startTieredEntryShadowScheduler();
    startTieredRecentSignalPump();
    startLiveReadinessScheduler();
  } else {
    console.log(
      `[monitor-bootstrap] trading schedulers disabled in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${TRADING_ENGINE_SERVICE}`
    );
  }

  startPaperAutoResumeScheduler();

  if (ownsWalletMonitor) {
    // worker/monitor.ts owns all Helius webhook/WebSocket and reconciliation work.
    // Import it in exactly one Railway service to prevent duplicate credit usage.
    await import("./monitor");
  } else {
    console.log(
      `[monitor-bootstrap] Helius wallet monitor not started in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${WALLET_DISCOVERY_SERVICE}`
    );
  }
}

bootstrap().catch((error) => {
  console.error("[monitor-bootstrap] startup failed:", error);
  process.exit(1);
});
