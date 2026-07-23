import "dotenv/config";
import { startMarketDiscoveryAgent } from "../paper-trader/marketDiscoveryAgent";
import { startAiDiscoveryTrader } from "../paper-trader/aiDiscoveryTrader";

startMarketDiscoveryAgent();
startAiDiscoveryTrader();
void import("./monitorBootstrap");
