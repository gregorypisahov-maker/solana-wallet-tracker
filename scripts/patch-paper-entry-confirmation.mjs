import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_PATH = "paper-trader/engine.ts";
const INSTALL_MARKER = "[entry-confirmation] pending confirmation already running";

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) {
    throw new Error(`[entry-confirmation] ${label} anchor not found`);
  }

  return source.replace(oldText, newText);
}

export function patchEngineSource(source) {
  if (source.includes(INSTALL_MARKER)) {
    return { changed: false, source };
  }

  let updated = source;

  updated = replaceRequired(
    updated,
    'import { getPriceUsd } from "./priceFeed";',
    `import { getPriceUsd } from "./priceFeed";\nimport {\n  evaluateEntryConfirmation,\n  waitForEntryConfirmation,\n} from "./entryConfirmation";`,
    "price-feed import"
  );

  updated = replaceRequired(
    updated,
    "let engineOperationTail: Promise<void> = Promise.resolve();",
    `let engineOperationTail: Promise<void> = Promise.resolve();\nconst pendingEntryMints = new Set<string>();`,
    "engine lock"
  );

  const oldOnAlert = `export async function onAlert(\n  alert: AlertInput\n): Promise<void> {\n  return runEngineOperation(() => processAlert(alert));\n}`;

  const newOnAlert = `export async function onAlert(\n  alert: AlertInput\n): Promise<void> {\n  const normalizedAlert: AlertInput = {\n    ...alert,\n    signalSource: alert.signalSource ?? "wallet_consensus",\n    strategyVersion: REGULAR_STRATEGY_VERSION,\n  };\n\n  // Do not delay alerts that already fail the frozen entry rules. Qualifying\n  // alerts get a second market-price sample outside the engine lock, so open\n  // positions continue receiving their normal stop/exit checks during the wait.\n  const initialEvaluation = evaluateEntry(normalizedAlert);\n  if (!initialEvaluation.pass) {\n    return runEngineOperation(() => processAlert(normalizedAlert));\n  }\n\n  if (pendingEntryMints.has(normalizedAlert.mint)) {\n    console.log(\n      \`[entry-confirmation] pending confirmation already running for \${normalizedAlert.tokenSymbol}\`\n    );\n    return;\n  }\n\n  pendingEntryMints.add(normalizedAlert.mint);\n\n  try {\n    const initialPrice = await getPriceUsd(normalizedAlert.mint);\n    await waitForEntryConfirmation();\n    const confirmedPrice = await getPriceUsd(normalizedAlert.mint);\n    const confirmation = evaluateEntryConfirmation(\n      initialPrice.priceUsd,\n      confirmedPrice.priceUsd\n    );\n\n    if (!confirmation.pass) {\n      const reason = confirmation.reason ?? "entry confirmation failed";\n      console.log(\n        \`[PAPER CONFIRM REJECT] \${normalizedAlert.tokenSymbol}: \${reason}\`\n      );\n      await notify(\n        \`🟠 <b>[PAPER] Entry confirmation rejected</b>\\n\\n\` +\n          \`Token: <b>\${normalizedAlert.tokenSymbol}</b>\\n\` +\n          \`Reason: \${reason}\\n\` +\n          \`First price: $\${initialPrice.priceUsd}\\n\` +\n          \`Confirmed price: $\${confirmedPrice.priceUsd}\`\n      );\n      return;\n    }\n\n    await runEngineOperation(() =>\n      processAlert(normalizedAlert, confirmedPrice.priceUsd)\n    );\n  } catch (error) {\n    const reason = getErrorMessage(error);\n    console.log(\n      \`[PAPER SKIP] \${normalizedAlert.tokenSymbol}: entry confirmation failed — \${reason}\`\n    );\n    await notify(\n      \`⏭️ <b>[PAPER] Trade skipped</b>\\n\\n\` +\n        \`Token: <b>\${normalizedAlert.tokenSymbol}</b>\\n\` +\n        \`Reason: Entry confirmation failed\\n\` +\n        \`Details: \${reason}\`\n    );\n  } finally {\n    pendingEntryMints.delete(normalizedAlert.mint);\n  }\n}`;

  updated = replaceRequired(updated, oldOnAlert, newOnAlert, "onAlert");

  updated = replaceRequired(
    updated,
    `async function processAlert(\n  alert: AlertInput\n): Promise<void> {`,
    `async function processAlert(\n  alert: AlertInput,\n  confirmedRawPriceUsd?: number\n): Promise<void> {`,
    "processAlert signature"
  );

  const oldPriceFetch = `  let entryPrice: number;\n\n  try {\n    const priceData = await getPriceUsd(alert.mint);\n    entryPrice = applyEntryFriction(\n      priceData.priceUsd,\n      config.execution.entryFrictionPct\n    );`;

  const newPriceFetch = `  let entryPrice: number;\n\n  try {\n    const rawEntryPriceUsd =\n      confirmedRawPriceUsd ?? (await getPriceUsd(alert.mint)).priceUsd;\n    entryPrice = applyEntryFriction(\n      rawEntryPriceUsd,\n      config.execution.entryFrictionPct\n    );`;

  updated = replaceRequired(
    updated,
    oldPriceFetch,
    newPriceFetch,
    "entry price fetch"
  );

  return { changed: true, source: updated };
}

function install() {
  const source = fs.readFileSync(ENGINE_PATH, "utf8");
  const result = patchEngineSource(source);

  if (!result.changed) {
    console.log("[entry-confirmation] already installed");
    return;
  }

  fs.writeFileSync(ENGINE_PATH, result.source);
  console.log(
    "[entry-confirmation] installed: 10s stability check, reject below -4% or above +6%"
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  install();
}
