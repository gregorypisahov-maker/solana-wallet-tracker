import fs from "node:fs";

const path = "worker/monitorBootstrap.ts";
let source = fs.readFileSync(path, "utf8");

const importLine = 'import { startWalletIntelligenceScheduler } from "./walletIntelligence";';
const profilerImport = 'import { startWalletLabProfilerScheduler } from "./walletLabProfiler";';
if (!source.includes(profilerImport)) {
  if (!source.includes(importLine)) throw new Error("Wallet Lab patch: bootstrap import anchor not found");
  source = source.replace(importLine, `${importLine}\n${profilerImport}`);
}

const bootstrapAnchor = "  const walletIntakeActive = ownsWalletMonitor && WALLET_RPC_INTAKE_ENABLED;\n";
const startBlock = `${bootstrapAnchor}\n  // Provider-neutral historical profiling is safe with Alchemy polling and never calls Helius.\n  if (ownsWalletMonitor) {\n    startWalletLabProfilerScheduler();\n  }\n`;
if (!source.includes("startWalletLabProfilerScheduler();")) {
  if (!source.includes(bootstrapAnchor)) throw new Error("Wallet Lab patch: bootstrap start anchor not found");
  source = source.replace(bootstrapAnchor, startBlock);
}

fs.writeFileSync(path, source);
console.log("[patch] Wallet Lab provider-neutral profiler wired into wallet service");
