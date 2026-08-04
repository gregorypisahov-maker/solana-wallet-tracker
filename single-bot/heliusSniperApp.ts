import { startHeliusMillisecondSniper } from "./heliusMillisecondSniper";

// The old Gecko/DexScreener discovery scheduler must not compete with the
// event-driven Helius launch stream. Position management remains enabled by
// sniperPaperApp, but its timed discovery loop is disabled before import.
process.env.ENABLE_MOMENTUM_SCALPER = "false";

startHeliusMillisecondSniper();
await import("./sniperPaperApp");
