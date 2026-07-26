import "dotenv/config";
import { startMarketDiscoveryAgent } from "../paper-trader/marketDiscoveryAgent";
import { startAiDiscoveryTrader } from "../paper-trader/aiDiscoveryTrader";
import { startAiTradeAutopsyEngine } from "../paper-trader/aiTradeAutopsy";
import { startLiveExecutor } from "../live-executor/liveExecutor";

// AI-only runtime mode.
// Keep the AI market discovery scanner because it supplies ranked opportunities
// to the AI paper trader. Do not launch monitorBootstrap: it starts the legacy
// wallet polling, wallet lab/discovery, consensus engine, and other paper bots.
console.log("[worker] AI-only mode enabled; legacy wallet and trading engines are disabled");
startMarketDiscoveryAgent();
startAiDiscoveryTrader();
startAiTradeAutopsyEngine();

// The live executor mirrors fresh AI discovery entries and exits automatically.
// Its own two environment locks plus the database gate remain authoritative,
// so importing it here does not bypass any live-trading safety control.
startLiveExecutor();
