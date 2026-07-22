import "dotenv/config";
import { extractHeliusApiKey } from "../lib/heliusWebhook";
import { startWalletIntelligenceScheduler } from "./walletIntelligence";
import { startAuditedWalletDiscoveryScheduler } from "./walletDiscoveryAudit";
import { startShadowStrategyScheduler } from "./shadowStudyScheduler";
import { startAdaptiveStrategyScheduler } from "../paper-trader/adaptiveStrategy";
import { startPaperAutoResumeScheduler } from "./paperAutoResume";
import { startTieredEntryShadowScheduler } from "../paper-trader/tieredEntryShadow";
import { startTieredRecentSignalPump } from "../paper-trader/tieredRecentSignalPump";
import { startLiveReadinessScheduler } from "../paper-trader/liveReadiness";
import { startMomentumScalperScheduler } from "../paper-trader/momentumScalper";
import { startScalperShadowScheduler } from "../paper-trader/scalperShadow";
import { startBinanceFuturesPaperBot } from "../paper-trader/binanceFuturesPaperScheduler";

const WALLET_DISCOVERY_SERVICE = "Wallet Discovery & Monitor";
const TRADING_ENGINE_SERVICE = "Trading Engine";

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

const providerRpcUrl =
  process.env.SOLANA_RPC_URL?.trim() ||
  process.env.ALCHEMY_RPC_URL?.trim() ||
  process.env.HELIUS_RPC_URL?.trim() ||
  "";
const usingProviderNeutralRpc = Boolean(
  process.env.SOLANA_RPC_URL?.trim() || process.env.ALCHEMY_RPC_URL?.trim()
);

// Helius intake remains opt-in because its credits can be exhausted. A configured
// provider-neutral RPC (for example Alchemy) automatically enables the core
// wallet WebSocket monitor and reconciliation without enabling Helius webhooks.
const HELIUS_INTAKE_ENABLED = envFlag("ENABLE_HELIUS_INTAKE", false);
const WALLET_RPC_INTAKE_ENABLED = Boolean(providerRpcUrl) &&
  (usingProviderNeutralRpc || HELIUS_INTAKE_ENABLED);

function shouldStartWalletManagement(): boolean {
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim();
  return !serviceName || serviceName === WALLET_DISCOVERY_SERVICE;
}

function shouldStartTradingStrategies(): boolean {
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim();
  return !serviceName || serviceName === TRADING_ENGINE_SERVICE;
}

type HeliusWebhookRecord = {
  webhookID?: string;
  webhookURL?: string;
  active?: boolean;
};

async function deactivateProjectHeliusWebhooks(): Promise<void> {
  const rpcUrl = process.env.HELIUS_RPC_URL?.trim();
  const apiKey = rpcUrl ? extractHeliusApiKey(rpcUrl) : null;
  if (!apiKey) {
    console.warn("[helius-emergency-stop] no Helius API key available; Helius webhook intake remains disabled");
    return;
  }

  const listUrl = new URL("https://mainnet.helius-rpc.com/v0/webhooks");
  listUrl.searchParams.set("api-key", apiKey);

  try {
    const response = await fetch(listUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(`[helius-emergency-stop] webhook list failed (${response.status}); Helius webhook intake remains disabled`);
      return;
    }

    const records = (await response.json()) as HeliusWebhookRecord[];
    const receiverUrls = new Set<string>();
    const configuredWebhookUrl = process.env.HELIUS_WEBHOOK_URL?.trim();
    if (configuredWebhookUrl) receiverUrls.add(configuredWebhookUrl);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
    if (supabaseUrl) receiverUrls.add(`${supabaseUrl}/functions/v1/helius-webhook`);
    receiverUrls.add("https://solana-wallet-tracker.vercel.app/api/helius");

    const matching = records.filter(
      (record) =>
        record.webhookID &&
        record.active !== false &&
        record.webhookURL &&
        receiverUrls.has(record.webhookURL)
    );
    const targets = matching.length > 0
      ? matching
      : records.length === 1 && records[0]?.webhookID && records[0].active !== false
        ? records
        : [];

    if (targets.length === 0) {
      console.log("[helius-emergency-stop] no active project webhook found");
      return;
    }

    for (const record of targets) {
      const updateUrl = new URL(
        `https://mainnet.helius-rpc.com/v0/webhooks/${record.webhookID}`
      );
      updateUrl.searchParams.set("api-key", apiKey);
      const disableResponse = await fetch(updateUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!disableResponse.ok) {
        console.warn(
          `[helius-emergency-stop] failed to deactivate webhook ${record.webhookID} (${disableResponse.status})`
        );
      } else {
        console.log(`[helius-emergency-stop] deactivated webhook ${record.webhookID}`);
      }
    }
  } catch (error) {
    console.warn(
      "[helius-emergency-stop] webhook deactivation failed; Helius webhook intake remains disabled:",
      error
    );
  }
}

async function bootstrap(): Promise<void> {
  const ownsWalletMonitor = shouldStartWalletManagement();
  const walletIntakeActive = ownsWalletMonitor && WALLET_RPC_INTAKE_ENABLED;

  if (ownsWalletMonitor && usingProviderNeutralRpc) {
    // Never let the legacy Helius webhook manager run against an Alchemy-backed
    // monitor. The existing monitor will use standard Solana WebSockets instead.
    process.env.HELIUS_EVENT_MODE = "websocket";
    if (!HELIUS_INTAKE_ENABLED) {
      await deactivateProjectHeliusWebhooks();
    }
    console.log("[monitor-bootstrap] provider-neutral Solana RPC intake active in WebSocket mode");
  } else if (ownsWalletMonitor && !HELIUS_INTAKE_ENABLED) {
    await deactivateProjectHeliusWebhooks();
    console.warn(
      "[monitor-bootstrap] WALLET INTAKE PAUSED: add SOLANA_RPC_URL/ALCHEMY_RPC_URL, or deliberately re-enable Helius intake"
    );
  } else if (walletIntakeActive) {
    startAuditedWalletDiscoveryScheduler();
    startWalletIntelligenceScheduler();
    console.log("[monitor-bootstrap] automatic Helius wallet discovery active");
  } else {
    console.log(
      `[monitor-bootstrap] wallet management disabled in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${WALLET_DISCOVERY_SERVICE}`
    );
  }

  if (shouldStartTradingStrategies()) {
    startAdaptiveStrategyScheduler();
    startShadowStrategyScheduler();
    // Losing scalper entry scans are disabled by their per-module flags.
    // Exit managers stay active so any existing paper positions can close normally.
    startMomentumScalperScheduler();
    startScalperShadowScheduler();
    startTieredEntryShadowScheduler();
    startTieredRecentSignalPump();
    startLiveReadinessScheduler();
    startBinanceFuturesPaperBot();
    console.log(
      "[monitor-bootstrap] active paper strategies: Legion, manipulation-resistant Shadow, Tiered, Binance BTC pump-fade; scalpers exit-only"
    );
  } else {
    console.log(
      `[monitor-bootstrap] trading schedulers disabled in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${TRADING_ENGINE_SERVICE}`
    );
  }

  startPaperAutoResumeScheduler();

  if (walletIntakeActive) {
    // worker/monitor.ts uses standard Solana RPC/WebSockets. Helius-specific
    // webhooks are forced off when a provider-neutral RPC is configured.
    await import("./monitor");
  } else if (ownsWalletMonitor) {
    console.warn("[monitor-bootstrap] core wallet monitor not started because no usable RPC intake is configured");
  } else {
    console.log(
      `[monitor-bootstrap] core wallet monitor not started in ${process.env.RAILWAY_SERVICE_NAME}; ` +
        `owned by ${WALLET_DISCOVERY_SERVICE}`
    );
  }
}

bootstrap().catch((error) => {
  console.error("[monitor-bootstrap] startup failed:", error);
  process.exit(1);
});
