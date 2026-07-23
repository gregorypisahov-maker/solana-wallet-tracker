import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { patchEngineSource } from "../scripts/patch-paper-entry-confirmation.mjs";
import { patchMainCostModel } from "../scripts/patch-p0-main-costs.mjs";

function assertTranspiles(source: string, fileName: string): void {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.deepEqual(
    errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    []
  );
}

test("MAIN P0 patch installs after the existing entry-confirmation patch", () => {
  const original = readFileSync("paper-trader/engine.ts", "utf8");
  const confirmed = patchEngineSource(original).source;
  const result = patchMainCostModel(confirmed);

  assert.equal(result.changed, true);
  assert.match(result.source, /calculateEntryExecutionCosts/);
  assert.match(result.source, /appendFailedPaperEntry/);
  assert.match(result.source, /grossPnlSol/);
  assert.match(result.source, /costModelVersion/);
  assertTranspiles(result.source, "paper-trader/engine.ts");
});