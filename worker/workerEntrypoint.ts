import "dotenv/config";
import { startMarketDiscoveryAgent } from "../paper-trader/marketDiscoveryAgent";
import { startAiTradeAutopsyEngine } from "../paper-trader/aiTradeAutopsy";

// Research-only runtime mode.
// Keep market discovery and trade autopsy data collection running so the existing
// history can still be analysed. AI Discovery paper execution, its AI Capital
// mirror, and the real-money live executor are deliberately not started.
// Historical database rows remain untouched.
console.log("[worker] research-only mode enabled; AI Discovery trading and live execution are disabled");
startMarketDiscoveryAgent();
startAiTradeAutopsyEngine();
