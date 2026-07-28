import "dotenv/config";
import { startMarketDiscoveryAgent } from "../paper-trader/marketDiscoveryAgent";
import { startAiDiscoveryTrader } from "../paper-trader/aiDiscoveryTrader";
import { startAiCapitalMirror } from "../paper-trader/aiCapitalMirror";
import { startAiTradeAutopsyEngine } from "../paper-trader/aiTradeAutopsy";
import { startAiMoonbagShadow } from "../paper-trader/aiMoonbagShadow";

// Paper-only AI runtime. AI Discovery and its AI Capital mirror remain controlled
// by their Supabase state rows. Real-money execution runs only in the dedicated
// live-executor Railway service and is never started by this worker.
console.log("[worker] paper-only AI runtime starting; live execution is isolated in its dedicated service");
startMarketDiscoveryAgent();
startAiDiscoveryTrader();
startAiCapitalMirror();
startAiTradeAutopsyEngine();
startAiMoonbagShadow();
