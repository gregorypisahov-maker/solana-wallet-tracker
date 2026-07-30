import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("main paper safety records Helius eligibility without enforcing trade_eligible", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "live-executor/liveSafety.ts"),
    "utf8"
  );

  assert.match(source, /heliusEligible/);
  assert.match(source, /heliusRecommendation/);
  assert.match(source, /heliusSignalVersion/);
  assert.match(source, /heliusWouldBlock/);
  assert.match(source, /helius would_block .*\(shadow, not enforced\)/);
  assert.doesNotMatch(source, /reject\("helius_trade_not_eligible"/);
});

test("legacy AI outcome writer is disabled before the worker starts", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
  ) as { scripts?: Record<string, string> };
  const worker = packageJson.scripts?.worker ?? "";

  assert.match(worker, /apply-ai-helius-shadow-outcomes\.mjs/);
});
