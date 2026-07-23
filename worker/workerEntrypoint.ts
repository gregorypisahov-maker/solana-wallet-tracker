import "dotenv/config";
import { startMarketDiscoveryAgent } from "../paper-trader/marketDiscoveryAgent";

startMarketDiscoveryAgent();
await import("./monitorBootstrap");
