import fs from "node:fs";

const path = "paper-trader/aiDiscoveryTrader.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`anchor_missing:${label}`);
  if (source.indexOf(anchor, first + anchor.length) >= 0) throw new Error(`anchor_not_unique:${label}`);
  source = source.replace(anchor, replacement);
}

if (!source.includes('type TokenSafetyResult')) {
  replaceOnce(
    'import { checkTokenSafety } from "../lib/tokenSafety";\n',
    'import { checkTokenSafety, type TokenSafetyResult } from "../lib/tokenSafety";\n',
    "typed-import"
  );
}

replaceOnce(
  'async function logEntryScreenRejection(\n  opportunity,\n  result\n) {\n',
  'async function logEntryScreenRejection(\n  opportunity: any,\n  result: TokenSafetyResult\n): Promise<void> {\n',
  "typed-rejection-helper"
);

fs.writeFileSync(path, source);
console.log("entry safety typing fix applied");
