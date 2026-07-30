import fs from "node:fs";

function replaceRequired(path, before, after, label) {
  let source = fs.readFileSync(path, "utf8");
  if (!source.includes(before)) throw new Error(`${path}: missing pattern ${label}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

replaceRequired(
  "paper-trader/marketDiscoveryAgent.ts",
  "const REQUEST_TIMEOUT_MS = 12_000;\n",
  "",
  "unused discovery request timeout"
);

replaceRequired(
  "lib/geckoFetch.ts",
  "let lastRequestAt = 0;\n",
  "",
  "unused Gecko last request timestamp"
);

replaceRequired(
  "lib/geckoFetch.ts",
  "    lastRequestAt = Date.now();\n",
  "",
  "unused Gecko request timestamp assignment"
);

console.log("Helius price codemod cleanup applied.");
