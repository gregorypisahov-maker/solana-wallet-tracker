import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_PATH = "paper-trader/engine.ts";
const MARKER = "[paper-costs:p0] MAIN explicit costs installed";

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) {
    throw new Error(`[paper-costs:p0] MAIN ${label} anchor not found`);
  }
  return source.replace(oldText, newText);
}

export function patchMainCostModel(source) {
  if (source.includes(MARKER)) return { changed: false, source };
  let updated = source;

  updated = replaceRequired(
    updated,
    'import { applyEntryFriction, applyExitFriction } from "./executionFriction";',
    `import { applyEntryFriction, applyExitFriction } from "./executionFriction";
import {
  PAPER_COST_MODEL,
  appendFailedPaperEntry,
  calculateEntryExecutionCosts,
  calculateExitExecutionCosts,
  shouldSimulateFailedEntry,
} from "./executionCosts";`,
    "cost import"
  );

  updated = replaceRequired(
    updated,
    `  const sizeSol =
    state.bankrollSol *`,
    `  if (PAPER_COST_MODEL.enabled) {
    // The legacy 0.6% price haircut remains the disabled-mode behavior only.
    entryPrice /= 1 + config.execution.entryFrictionPct;
  }

  const sizeSol =
    state.bankrollSol *`,
    "raw entry price"
  );

  const oldBankrollGuard = `  if (sizeSol > state.bankrollSol) {
    await notify(
      \`⏭️ <b>[PAPER] Trade skipped</b>\\n\\n\` +
        \`Token: <b>\${alert.tokenSymbol}</b>\\n\` +
        \`Reason: Insufficient simulated bankroll\`
    );

    return;
  }

  const entryTime = Date.now();`;

  const newBankrollGuard = `  let entryCosts;
  try {
    entryCosts = calculateEntryExecutionCosts(sizeSol, alert.liquidityUsd);
  } catch (error) {
    const reason = getErrorMessage(error);
    console.log(\`[PAPER SKIP] \${alert.tokenSymbol}: cost model failed closed — \${reason}\`);
    await notify(
      \`⏭️ <b>[PAPER] Trade skipped</b>\\n\\n\` +
        \`Token: <b>\${alert.tokenSymbol}</b>\\n\` +
        \`Reason: Cost model failed closed\\n\` +
        \`Details: \${reason}\`
    );
    return;
  }

  if (shouldSimulateFailedEntry()) {
    state.bankrollSol -= entryCosts.networkFeeSol;
    await saveState(state);
    await appendFailedPaperEntry({
      strategy: "MAIN",
      mint: alert.mint,
      tokenSymbol: alert.tokenSymbol,
      attemptedSizeSol: sizeSol,
      liquidityUsd: alert.liquidityUsd,
      networkFeeSol: entryCosts.networkFeeSol,
      snapshot: { signal_source: alert.signalSource ?? "wallet_consensus" },
    });
    console.log(
      \`[PAPER FAILED ENTRY] \${alert.tokenSymbol}: network fee \${entryCosts.networkFeeSol.toFixed(6)} SOL charged\`
    );
    await notify(
      \`⚠️ <b>[PAPER] Entry transaction failed</b>\\n\\n\` +
        \`Token: <b>\${alert.tokenSymbol}</b>\\n\` +
        \`Network cost: \${entryCosts.networkFeeSol.toFixed(6)} SOL\\n\` +
        \`No position opened.\`
    );
    return;
  }

  const totalEntryDebitSol = sizeSol + entryCosts.totalSol;
  if (totalEntryDebitSol > state.bankrollSol) {
    await notify(
      \`⏭️ <b>[PAPER] Trade skipped</b>\\n\\n\` +
        \`Token: <b>\${alert.tokenSymbol}</b>\\n\` +
        \`Reason: Insufficient simulated bankroll after costs\`
    );
    return;
  }

  const entryTime = Date.now();`;

  updated = replaceRequired(updated, oldBankrollGuard, newBankrollGuard, "entry costs");

  updated = replaceRequired(
    updated,
    `    positionId: makePositionId(alert.mint, entryTime),
    realizedPnlSol: 0,
  };`,
    `    positionId: makePositionId(alert.mint, entryTime),
    realizedPnlSol: 0,
    entryFeeSol: entryCosts.networkFeeSol + entryCosts.swapFeeSol,
    entrySlippageSol: entryCosts.slippageSol,
    entryLiquidityUsd: alert.liquidityUsd,
    costModelVersion: entryCosts.costModelVersion,
  };`,
    "position costs"
  );

  updated = replaceRequired(
    updated,
    `    state.bankrollSol -= sizeSol;`,
    `    state.bankrollSol -= totalEntryDebitSol;`,
    "entry bankroll debit"
  );

  updated = replaceRequired(
    updated,
    `    let currentPrice: number;`,
    `    let currentPrice: number;`,
    "exit price declaration"
  );

  updated = replaceRequired(
    updated,
    `      currentPrice = applyExitFriction(
        priceData.priceUsd,
        config.execution.exitFrictionPct
      );`,
    `      currentPrice = applyExitFriction(
        priceData.priceUsd,
        config.execution.exitFrictionPct
      );
      if (PAPER_COST_MODEL.enabled) {
        currentPrice /= 1 - config.execution.exitFrictionPct;
      }
      (position as OpenPosition & { currentLiquidityUsd?: number }).currentLiquidityUsd =
        priceData.liquidityUsd ?? position.entryLiquidityUsd;`,
    "raw exit price and liquidity"
  );

  const oldSellMath = `  const proceedsSol =
    soldSizeSol * multiple;

  const pnlSol =
    proceedsSol - soldSizeSol;

  state.bankrollSol += proceedsSol;
  position.realizedPnlSol += pnlSol;`;

  const newSellMath = `  const grossProceedsSol = soldSizeSol * multiple;
  const grossPnlSol = grossProceedsSol - soldSizeSol;
  const exitLiquidityUsd =
    (position as OpenPosition & { currentLiquidityUsd?: number }).currentLiquidityUsd ??
    position.entryLiquidityUsd;
  const exitCosts = calculateExitExecutionCosts(grossProceedsSol, exitLiquidityUsd);
  const allocatedEntryFeeSol = position.entryFeeSol * soldPct;
  const allocatedEntrySlippageSol = position.entrySlippageSol * soldPct;
  const exitFeeSol = exitCosts.networkFeeSol + exitCosts.swapFeeSol;
  const slippageSol = allocatedEntrySlippageSol + exitCosts.slippageSol;
  const proceedsSol = grossProceedsSol - exitCosts.totalSol;
  const pnlSol =
    grossPnlSol - allocatedEntryFeeSol - exitFeeSol - slippageSol;

  state.bankrollSol += proceedsSol;
  position.realizedPnlSol += pnlSol;`;

  updated = replaceRequired(updated, oldSellMath, newSellMath, "sell costs");

  updated = replaceRequired(
    updated,
    `    proceedsSol: Number(
      proceedsSol.toFixed(4)
    ),
    pnlSol: Number(
      pnlSol.toFixed(4)
    ),`,
    `    proceedsSol: Number(proceedsSol.toFixed(6)),
    grossPnlSol: Number(grossPnlSol.toFixed(6)),
    entryFeeSol: Number(allocatedEntryFeeSol.toFixed(6)),
    exitFeeSol: Number(exitFeeSol.toFixed(6)),
    slippageSol: Number(slippageSol.toFixed(6)),
    pnlSol: Number(pnlSol.toFixed(6)),
    costModelVersion:
      position.costModelVersion ??
      (PAPER_COST_MODEL.enabled ? PAPER_COST_MODEL.version : "legacy_price_friction"),`,
    "trade cost fields"
  );

  updated += `\n// ${MARKER}\n`;
  return { changed: true, source: updated };
}

function install() {
  const source = fs.readFileSync(ENGINE_PATH, "utf8");
  const result = patchMainCostModel(source);
  if (!result.changed) {
    console.log(MARKER);
    return;
  }
  fs.writeFileSync(ENGINE_PATH, result.source);
  console.log(MARKER);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) install();
