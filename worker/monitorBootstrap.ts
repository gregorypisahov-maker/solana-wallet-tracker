import "dotenv/config";
import { startWalletDiscoveryScheduler } from "./walletDiscovery";

startWalletDiscoveryScheduler();
await import("./monitor");
