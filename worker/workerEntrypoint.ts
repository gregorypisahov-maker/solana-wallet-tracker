import "dotenv/config";
import "../lib/geckoFetch";
import "../scripts/lpLockShadowAudit";
import { startMarketDiscoveryAgent } from "../paper-trader/marketDiscoveryAgent";
import { startAiTradeAutopsyEngine } from "../paper-trader/aiTradeAutopsy";
import { startAiOutcomeTrackerV10 } from "../paper-trader/aiOutcomeTrackerV10";

// Paper trading must keep testing the proven AI strategy. The new live-style
// safety screen still runs and records every result, but it must not block a
// paper entry unless enforcement is explicitly re-enabled later.
process.env.AI_PAPER_ENTRY_SAFETY_ENABLED ??= "true";
process.env.AI_PAPER_ENTRY_SAFETY_ENFORCE = "false";

async function startPaperRuntime(): Promise<void> {
  const [{ startAiDiscoveryTrader }, { startAiCapitalMirror }] = await Promise.all([
    import("../paper-trader/aiDiscoveryTrader"),
    import("../paper-trader/aiCapitalMirror"),
  ]);

  console.log(
    "[worker] paper-only AI runtime starting; safety checks are observation-only and live execution remains isolated"
  );
  startMarketDiscoveryAgent();
  startAiDiscoveryTrader();
  startAiOutcomeTrackerV10();
  startAiCapitalMirror();
  startAiTradeAutopsyEngine();
}

void startPaperRuntime().catch((error) => {
  console.error("[worker] paper runtime failed to start", error);
  process.exitCode = 1;
});
