import "dotenv/config";
import { startWalletIntelligenceScheduler } from "./walletIntelligence";
import { startWalletLabScheduler } from "./walletLab";
import { startAuditedWalletDiscoveryScheduler } from "./walletDiscoveryAudit";
import { startShadowStrategyScheduler } from "./shadowStrategyScheduler";
import { startLabStrategyScheduler } from "./labStrategyScheduler";
import { startAdaptiveStrategyScheduler } from "../paper-trader/adaptiveStrategy";
import { startPaperAutoResumeScheduler } from "./paperAutoResume";
import { startTieredEntryShadowScheduler } from "../paper-trader/tieredEntryShadow";
import { startTieredRecentSignalPump } from "../paper-trader/tieredRecentSignalPump";
import { startLiveReadinessScheduler } from "../paper-trader/liveReadiness";
import { startMomentumScalperScheduler } from "../paper-trader/momentumScalper";
import { startScalperShadowScheduler } from "../paper-trader/scalperShadow";

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
    // Audited discovery owns automatic trial-wallet intake. Wallet Lab remains an
    // isolated observer and never promotes wallets by itself.
    startAuditedWalletDiscoveryScheduler();
    startWalletIntelligenceScheduler();
    startWalletLabScheduler();
    console.log(
      "[monitor-bootstrap] automatic Helius wallet discovery active; Wallet Lab remains isolated"
    );
  } else {
    console.log(
      `[monitor-bootstrap] wallet management disabled in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${WALLET_DISCOVERY_SERVICE}`
    );
  }

  if (shouldStartTradingStrategies()) {
    startAdaptiveStrategyScheduler();
    startShadowStrategyScheduler();
    startLabStrategyScheduler();
    // Losing scalper entry scans are disabled by their per-module flags.
    // Exit managers stay active so any existing paper positions can close normally.
    startMomentumScalperScheduler();
    startScalperShadowScheduler();
    startTieredEntryShadowScheduler();
    startTieredRecentSignalPump();
    startLiveReadinessScheduler();
    console.log(
      "[monitor-bootstrap] active paper strategies: Legion, Shadow, Lab Shadow, Lab Legion; scalpers exit-only"
    );
  } else {
    console.log(
      `[monitor-bootstrap] trading schedulers disabled in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${TRADING_ENGINE_SERVICE}`
    );
  }

  startPaperAutoResumeScheduler();

  if (ownsWalletMonitor) {
    // worker/monitor.ts owns all core-wallet Helius webhook/WebSocket and reconciliation work.
    // Lab trial wallets use their own capped 60-second intake in Trading Engine.
    await import("./monitor");
  } else {
    console.log(
      `[monitor-bootstrap] core Helius wallet monitor not started in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${WALLET_DISCOVERY_SERVICE}`
    );
  }
}

bootstrap().catch((error) => {
  console.error("[monitor-bootstrap] startup failed:", error);
  process.exit(1);
});
