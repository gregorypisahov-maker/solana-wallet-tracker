import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = "paper-trader/tieredRecentSignalPump.ts";
const MARKER = "[paper-costs:p0] TIERED entry costs installed";

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) {
    throw new Error(`[paper-costs:p0] TIERED ${label} anchor not found`);
  }
  return source.replace(oldText, newText);
}

export function patchTieredEntryCosts(source) {
  if (source.includes(MARKER)) return { changed: false, source };
  let updated = source;

  updated = replaceRequired(
    updated,
    'import { applyEntryFriction } from "./executionFriction";',
    `import { applyEntryFriction } from "./executionFriction";
import {
  PAPER_COST_MODEL,
  calculateEntryExecutionCosts,
  shouldSimulateFailedEntry,
} from "./executionCosts";`,
    "cost import"
  );

  updated = replaceRequired(
    updated,
    'supabase.from("tiered_state").select("halted,halt_reason").eq("id", 1).single()',
    'supabase.from("tiered_state").select("halted,halt_reason,bankroll_sol").eq("id", 1).single()',
    "bankroll selection"
  );

  const oldEntry = `    const entryPrice = applyEntryFriction(price.priceUsd, config.execution.entryFrictionPct);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      reasons.push("missing_data:entry_price");
      await writeLog(false);
      return;
    }

    const positionId = \`tiered_\${randomUUID()}\`;`;

  const newEntry = `    const entryPrice = PAPER_COST_MODEL.enabled
      ? price.priceUsd
      : applyEntryFriction(price.priceUsd, config.execution.entryFrictionPct);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      reasons.push("missing_data:entry_price");
      await writeLog(false);
      return;
    }

    const bankrollSol = n(state.bankroll_sol, 0);
    const attemptedSizeSol = bankrollSol * config.position.sizePctPerTrade;
    let entryCosts;
    try {
      entryCosts = calculateEntryExecutionCosts(
        attemptedSizeSol,
        Number(price.liquidityUsd)
      );
    } catch (costError) {
      const message = costError instanceof Error ? costError.message : String(costError);
      reasons.push(\`cost_model_failed_closed:\${message}\`);
      snapshot.cost_model_error = message;
      await writeLog(false);
      return;
    }

    snapshot.execution_costs = {
      model: entryCosts.costModelVersion,
      attempted_size_sol: attemptedSizeSol,
      network_fee_sol: entryCosts.networkFeeSol,
      swap_fee_sol: entryCosts.swapFeeSol,
      slippage_sol: entryCosts.slippageSol,
      liquidity_usd: entryCosts.liquidityUsd,
    };

    if (shouldSimulateFailedEntry()) {
      const { data: failedResult, error: failedError } = await supabase.rpc(
        "tiered_charge_failed_entry",
        {
          p_mint: row.token_mint,
          p_token_symbol: market.symbol ?? scoreR.data?.token_symbol ?? "UNKNOWN",
          p_attempted_size_sol: attemptedSizeSol,
          p_liquidity_usd: entryCosts.liquidityUsd,
          p_network_fee_sol: entryCosts.networkFeeSol,
          p_cost_model_version: PAPER_COST_MODEL.version,
          p_cost_snapshot: snapshot.execution_costs,
        }
      );
      if (failedError || !failedResult?.charged) {
        reasons.push(
          \`failed_entry_charge_error:\${failedError?.message ?? failedResult?.reason ?? "unknown"}\`
        );
      } else {
        reasons.push("simulated_entry_transaction_failed");
        snapshot.failed_entry_result = failedResult;
      }
      await writeLog(false);
      return;
    }

    const positionId = \`tiered_\${randomUUID()}\`;`;

  updated = replaceRequired(updated, oldEntry, newEntry, "entry calculation");

  updated = replaceRequired(
    updated,
    `      p_entry_wallet_trust: trust,
      p_filter_snapshot: snapshot,
    });`,
    `      p_entry_wallet_trust: trust,
      p_filter_snapshot: snapshot,
      p_entry_fee_sol: entryCosts.networkFeeSol + entryCosts.swapFeeSol,
      p_entry_slippage_sol: entryCosts.slippageSol,
      p_cost_model_version: PAPER_COST_MODEL.enabled
        ? PAPER_COST_MODEL.version
        : null,
    });`,
    "cost-aware RPC arguments"
  );

  updated += `\n// ${MARKER}\n`;
  return { changed: true, source: updated };
}

function install() {
  const source = fs.readFileSync(TARGET, "utf8");
  const result = patchTieredEntryCosts(source);
  if (!result.changed) {
    console.log(MARKER);
    return;
  }
  fs.writeFileSync(TARGET, result.source);
  console.log(MARKER);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) install();
