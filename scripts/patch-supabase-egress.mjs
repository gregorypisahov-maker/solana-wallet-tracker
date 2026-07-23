import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, value) {
  fs.writeFileSync(path, value);
  console.log(`[patch-supabase-egress] updated ${path}`);
}

function replaceRequired(path, source, pattern, replacement, marker) {
  if (source.includes(marker)) return source;
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`Could not patch ${path}; target not found for ${marker}`);
  return next;
}

{
  const path = "worker/monitor.ts";
  let source = read(path);
  source = replaceRequired(
    path,
    source,
    /} from "\.\.\/paper-trader\/provenTraderRules";\n/,
    `} from "../paper-trader/provenTraderRules";\nimport { loadConsensusTransactionSnapshot } from "./consensusTransactionWindow";\n`,
    "loadConsensusTransactionSnapshot"
  );
  source = replaceRequired(
    path,
    source,
    /  const \{ data: buys, error \} =\s*\n\s*await supabase\s*\n\s*\.from\("wallet_transactions"\)\s*\n\s*\.select\(\s*\n\s*"wallet_address, token_mint, sol_amount, tx_time"\s*\n\s*\)\s*\n\s*\.eq\("side", "buy"\)\s*\n\s*\.eq\("is_scalp", false\)\s*\n\s*\.gte\("tx_time", windowStart\);\s*\n\s*if \(error\) \{[\s\S]*?\n\s*return;\s*\n\s*}\s*\n\s*if \(!buys\?\.length\) \{\s*\n\s*return;\s*\n\s*}/,
    `  const transactionSnapshot = await loadConsensusTransactionSnapshot(\n    ALERT_WINDOW_HOURS,\n    SCALP_WINDOW_MINUTES\n  );\n  const buys = transactionSnapshot.buys;\n\n  if (!buys.length) {\n    return;\n  }`,
    "const transactionSnapshot = await loadConsensusTransactionSnapshot"
  );
  source = replaceRequired(
    path,
    source,
    /    const \{ data: sellRows, error: sellError \} =\s*\n\s*await supabase\s*\n\s*\.from\("wallet_transactions"\)\s*\n\s*\.select\("wallet_address"\)\s*\n\s*\.eq\(\s*\n\s*"token_mint",\s*\n\s*tokenMint\s*\n\s*\)\s*\n\s*\.eq\("side", "sell"\)\s*\n\s*\.eq\("is_scalp", false\)\s*\n\s*\.gte\(\s*\n\s*"tx_time",\s*\n\s*windowStart\s*\n\s*\);\s*\n\s*throwIfError\("Failed to load token sells", sellError\);\s*\n\s*const sellingWallets =\s*\n\s*new Set\(\s*\n\s*\(sellRows \?\? \[\]\)\.map\(\s*\n\s*\(row\) =>\s*\n\s*row\.wallet_address\s*\n\s*\)\s*\n\s*\);/,
    `    const sellingWallets =\n      transactionSnapshot.sellingWalletsByToken.get(tokenMint) ?? new Set<string>();`,
    "transactionSnapshot.sellingWalletsByToken"
  );
  source = replaceRequired(
    path,
    source,
    /  let checkingPositions = false;\n  setInterval\(async \(\) => \{/,
    `  const paperPositionCheckMs = Math.max(5_000, Number(process.env.PAPER_POSITION_CHECK_MS ?? 6_000));\n  let checkingPositions = false;\n  setInterval(async () => {`,
    "paperPositionCheckMs"
  );
  source = replaceRequired(
    path,
    source,
    /  \}, 5000\);\n\n  setInterval\(\(\) => \{\n    sendDailyPaperReportIfDue/,
    `  }, paperPositionCheckMs);\n\n  setInterval(() => {\n    sendDailyPaperReportIfDue`,
    "}, paperPositionCheckMs);"
  );
  write(path, source);
}

{
  const replacements = [
    {
      path: "paper-trader/storage.ts",
      before: ".from('paper_positions').select('*')",
      after: ".from('paper_positions').select('mint,token_symbol,entry_price,entry_time,size_sol,remaining_pct,peak_multiple,ladder_hits,entry_alert,position_id,realized_pnl_sol,entry_fee_sol,entry_slippage_sol,entry_liquidity_usd,cost_model_version')",
      markers: ["entry_fee_sol,entry_slippage_sol,entry_liquidity_usd,cost_model_version"],
    },
    {
      path: "paper-trader/shadowStrategy.ts",
      before: '.from("shadow_positions").select("*")',
      after: '.from("shadow_positions").select("mint,token_symbol,entry_price,entry_time,size_sol,remaining_pct,peak_multiple,entry_alert,position_id,realized_pnl_sol,entry_fee_sol,entry_slippage_sol,entry_liquidity_usd,cost_model_version")',
      markers: ["entry_fee_sol,entry_slippage_sol,entry_liquidity_usd,cost_model_version"],
    },
    {
      path: "paper-trader/momentumScalper.ts",
      before: '.from("scalp_positions").select("*").order("entry_time", { ascending: true })',
      after: '.from("scalp_positions").select("position_id,mint,token_symbol,pair_address,entry_price_usd,entry_time,size_sol,peak_price_usd").order("entry_time", { ascending: true })',
      markers: [],
    },
    {
      path: "paper-trader/scalperShadow.ts",
      before: "const CHECK_MS = 5_000;",
      after: "const CHECK_MS = Math.max(5_000, Number(process.env.SCALPER_SHADOW_POSITION_CHECK_MS ?? 6_000));",
      markers: [],
    },
    {
      path: "paper-trader/scalperShadow.ts",
      before: 'supabase.from("scalper_shadow_positions").select("*")',
      after: 'supabase.from("scalper_shadow_positions").select("mint")',
      markers: [],
    },
    {
      path: "paper-trader/scalperShadow.ts",
      before: 'supabase.from("scalper_shadow_positions").select("*");',
      after: 'supabase.from("scalper_shadow_positions").select("position_id,mint,token_symbol,pair_address,entry_price_usd,entry_time,size_sol,peak_price_usd,entry_snapshot");',
      markers: [],
    },
    {
      path: "paper-trader/momentumScalper.ts",
      before: "boundedInterval(process.env.SCALP_POSITION_CHECK_MS, 3_000, 3_000, 60_000)",
      after: "boundedInterval(process.env.SCALP_POSITION_CHECK_MS, 6_000, 5_000, 60_000)",
      markers: [],
    },
  ];
  const grouped = new Map();
  for (const replacement of replacements) {
    const list = grouped.get(replacement.path) ?? [];
    list.push(replacement);
    grouped.set(replacement.path, list);
  }
  for (const [path, list] of grouped) {
    let source = read(path);
    let changed = false;
    for (const { before, after, markers } of list) {
      if (source.includes(after) || markers.some((marker) => source.includes(marker))) continue;
      if (!source.includes(before)) throw new Error(`Could not patch ${path}; target not found: ${before}`);
      source = source.replace(before, after);
      changed = true;
    }
    if (changed) write(path, source);
  }
}

console.log("[patch-supabase-egress] Supabase egress optimizations active");