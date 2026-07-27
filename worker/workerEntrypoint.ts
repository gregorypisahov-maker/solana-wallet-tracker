import "dotenv/config";
import { startMarketDiscoveryAgent } from "../paper-trader/marketDiscoveryAgent";
import { startAiDiscoveryTrader } from "../paper-trader/aiDiscoveryTrader";
import { startAiTradeAutopsyEngine } from "../paper-trader/aiTradeAutopsy";
import { startLiveExecutor } from "../live-executor/liveExecutor";

// Stable AI runtime startup.
// Trading authorization remains controlled by the Supabase state rows and the
// live execution environment locks. The AI Discovery, AI Capital mirror, and
// live executor are currently disabled/halted in Supabase, so restoring these
// processes cannot open new positions but keeps the Railway worker healthy.
console.log("[worker] stable AI runtime restored; trading remains disabled by database safety gates");
startMarketDiscoveryAgent();
startAiDiscoveryTrader();
startAiTradeAutopsyEngine();
startLiveExecutor();
