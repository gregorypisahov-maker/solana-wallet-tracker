import "dotenv/config";
import { startMarketDiscoveryAgent } from "../paper-trader/marketDiscoveryAgent";
import { startAiDiscoveryTrader } from "../paper-trader/aiDiscoveryTrader";
import { startAiTradeAutopsyEngine } from "../paper-trader/aiTradeAutopsy";

// AI-only runtime mode.
// Keep the AI market discovery scanner because it supplies ranked opportunities
// to the AI paper trader. Do not launch monitorBootstrap: it starts the legacy
// wallet polling, wallet lab/discovery, consensus engine, and other paper bots.
console.log("[worker] AI-only mode enabled; legacy wallet and trading engines are disabled");
startMarketDiscoveryAgent();
startAiDiscoveryTrader();
startAiTradeAutopsyEngine();
