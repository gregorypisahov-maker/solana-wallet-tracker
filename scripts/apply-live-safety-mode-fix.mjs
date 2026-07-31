import fs from "node:fs";

const target = new URL("../live-executor/liveExecutor.ts", import.meta.url);
let source = fs.readFileSync(target, "utf8");

const oldCall = `  const safety = await evaluateLiveEntrySafety({
    mint: signal.mint,
    sizeSol: n(signal.requested_size_sol),
    slippageBps: signal.max_slippage_bps,
    expectedTokenAmount,
  });`;

const newCall = `  const safety = await evaluateLiveEntrySafety({
    mint: signal.mint,
    sizeSol: n(signal.requested_size_sol),
    slippageBps: signal.max_slippage_bps,
    expectedTokenAmount,
    mode: "live",
  });`;

if (source.includes(newCall)) {
  console.log("[live-safety-mode-fix] already active; no-op");
  process.exit(0);
}

if (!source.includes(oldCall)) {
  throw new Error("live safety mode patch anchor not found");
}

source = source.replace(oldCall, newCall);
fs.writeFileSync(target, source);
console.log("[live-safety-mode-fix] active: live executor forces fail-closed live safety mode");
