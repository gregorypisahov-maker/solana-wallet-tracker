import { readFileSync, writeFileSync } from "node:fs";

function replaceRequired(source, search, replacement, label) {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[supabase-efficiency] ${label} target not found`);
  }
  return source.replace(search, replacement);
}

function patchMonitor() {
  const path = "worker/monitor.ts";
  let source = readFileSync(path, "utf8");

  source = replaceRequired(
    source,
    `import {\n  isProvenTraderSignalProfile,\n  ProvenTraderSignalProfile,\n} from "../paper-trader/provenTraderRules";`,
    `import {\n  isProvenTraderSignalProfile,\n  ProvenTraderSignalProfile,\n} from "../paper-trader/provenTraderRules";\nimport { loadConsensusTransactionSnapshot } from "./consensusTransactionWindow";`,
    "monitor consensus-window import"
  );

  if (!source.includes("const PAPER_POSITION_CHECK_INTERVAL_MS")) {
    source = source.replace(
      /const MIN_TOTAL_SOL = ([^;]+);/,
      `const MIN_TOTAL_SOL = $1;\nconst PAPER_POSITION_CHECK_INTERVAL_MS = Math.floor(\n  readBoundedNumber(process.env.PAPER_POSITION_CHECK_INTERVAL_MS, 6_000, 3_000, 60_000)\n);`
    );
  }

  source = replaceRequired(
    source,
    `  const { data: buys, error } =\n    await supabase\n      .from("wallet_transactions")\n      .select(\n        "wallet_address, token_mint, sol_amount, tx_time"\n      )\n      .eq("side", "buy")\n      .eq("is_scalp", false)\n      .gte("tx_time", windowStart);\n\n  if (error) {\n    console.error(\n      "Failed to load buys:",\n      error\n    );\n\n    return;\n  }\n\n  if (!buys?.length) {\n    return;\n  }`,
    `  let consensusSnapshot;\n  try {\n    consensusSnapshot = await loadConsensusTransactionSnapshot(\n      ALERT_WINDOW_HOURS,\n      SCALP_WINDOW_MINUTES\n    );\n  } catch (error) {\n    console.error("Failed to refresh incremental consensus window:", error);\n    return;\n  }\n  const { buys, sellingWalletsByToken } = consensusSnapshot;\n\n  if (!buys.length) {\n    return;\n  }`,
    "monitor full 24-hour buy scan"
  );

  source = replaceRequired(
    source,
    `    const { data: sellRows, error: sellError } =\n      await supabase\n        .from("wallet_transactions")\n        .select("wallet_address")\n        .eq(\n          "token_mint",\n          tokenMint\n        )\n        .eq("side", "sell")\n        .eq("is_scalp", false)\n        .gte(\n          "tx_time",\n          windowStart\n        );\n    throwIfError("Failed to load token sells", sellError);\n\n    const sellingWallets =\n      new Set(\n        (sellRows ?? []).map(\n          (row) =>\n            row.wallet_address\n        )\n      );`,
    `    const sellingWallets =\n      sellingWalletsByToken.get(tokenMint) ?? new Set<string>();`,
    "monitor per-candidate sell scan"
  );

  source = replaceRequired(
    source,
    `  }, 5000);\n\n  setInterval(() => {\n    sendDailyPaperReportIfDue().catch(`,
    `  }, PAPER_POSITION_CHECK_INTERVAL_MS);\n\n  setInterval(() => {\n    sendDailyPaperReportIfDue().catch(`,
    "main paper position interval"
  );

  writeFileSync(path, source);
}

function patchTieredRecentPump() {
  const path = "paper-trader/tieredRecentSignalPump.ts";
  let source = readFileSync(path, "utf8");

  if (!source.includes("const TIERED_SIGNAL_POLL_MS")) {
    source = source.replace(
      "let running = false;",
      `let running = false;\nconst TIERED_SIGNAL_POLL_MS = Math.min(\n  60_000,\n  Math.max(3_000, Number(process.env.TIERED_SIGNAL_POLL_MS ?? 6_000))\n);\nconst TIERED_CURSOR_OVERLAP_MS = 2_000;\nconst processedSignalKeys = new Set<string>();\nlet processedSignalsLoaded = false;\nlet latestTransactionCreatedAtMs = 0;`
    );
  }

  source = replaceRequired(
    source,
    `async function alreadyProcessed(wallet: string, mint: string): Promise<boolean | null> {\n  const { data, error } = await supabase\n    .from("tiered_processed_signals")\n    .select("id")\n    .eq("wallet_address", wallet)\n    .eq("token_mint", mint)\n    .limit(1);\n  if (error) {\n    console.error("[tiered-entry] processed lookup failed; fail-closed:", error);\n    return null;\n  }\n  return Boolean(data?.length);\n}`,
    `async function loadProcessedSignalKeys(): Promise<void> {\n  if (processedSignalsLoaded) return;\n  const pageSize = 1_000;\n  for (let offset = 0; ; offset += pageSize) {\n    const { data, error } = await supabase\n      .from("tiered_processed_signals")\n      .select("wallet_address,token_mint")\n      .range(offset, offset + pageSize - 1);\n    if (error) throw new Error(\`tiered processed-signal preload failed: \${error.message}\`);\n    for (const row of data ?? []) {\n      processedSignalKeys.add(signalKey(row.wallet_address, row.token_mint));\n    }\n    if ((data ?? []).length < pageSize) break;\n  }\n  processedSignalsLoaded = true;\n  console.log(\`[tiered-entry] preloaded \${processedSignalKeys.size} processed signal keys\`);\n}`,
    "tiered N+1 dedup lookup"
  );

  source = replaceRequired(
    source,
    `    if (error && error.code !== "23505") throw new Error(\`tiered signal log failed: \${error.message}\`);`,
    `    if (error && error.code !== "23505") throw new Error(\`tiered signal log failed: \${error.message}\`);\n    processedSignalKeys.add(key);`,
    "tiered in-memory dedup update"
  );

  source = replaceRequired(
    source,
    `    const processed = await alreadyProcessed(row.wallet_address, row.token_mint);\n    if (processed === null || processed) {\n      pendingWork.delete(key);\n      return;\n    }`,
    `    if (processedSignalKeys.has(key)) {\n      pendingWork.delete(key);\n      return;\n    }`,
    "tiered inner dedup query"
  );

  const oldTick = `async function tick(): Promise<void> {\n  if (running) return;\n  running = true;\n  try {\n    const { data, error } = await supabase\n      .from("wallet_transactions")\n      .select("id,wallet_address,token_mint,sol_amount,tx_time")\n      .eq("side", "buy")\n      .gte("tx_time", new Date(Date.now() - RECENT_WINDOW_MS).toISOString())\n      .order("tx_time", { ascending: false })\n      .limit(200);\n    if (error) throw new Error(error.message);\n\n    for (const row of [...(data ?? [])].reverse()) {\n      if (pendingWork.has(signalKey(row.wallet_address, row.token_mint))) continue;\n      const processed = await alreadyProcessed(row.wallet_address, row.token_mint);\n      if (processed === null || processed) continue;\n      await processRecentBuy(row);\n    }\n  } catch (error) {\n    console.error("[tiered-entry] recent pump isolated failure:", error);\n  } finally {\n    running = false;\n  }\n}`;

  const newTick = `async function tick(): Promise<void> {\n  if (running) return;\n  running = true;\n  try {\n    await loadProcessedSignalKeys();\n    const recentCutoff = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();\n    let query = supabase\n      .from("wallet_transactions")\n      .select("id,wallet_address,token_mint,sol_amount,tx_time,created_at")\n      .eq("side", "buy")\n      .gte("tx_time", recentCutoff)\n      .order("created_at", { ascending: true })\n      .limit(500);\n    if (latestTransactionCreatedAtMs > 0) {\n      query = query.gte(\n        "created_at",\n        new Date(Math.max(0, latestTransactionCreatedAtMs - TIERED_CURSOR_OVERLAP_MS)).toISOString()\n      );\n    }\n    const { data, error } = await query;\n    if (error) throw new Error(error.message);\n\n    for (const row of data ?? []) {\n      const createdAtMs = Date.parse(row.created_at);\n      if (Number.isFinite(createdAtMs)) {\n        latestTransactionCreatedAtMs = Math.max(latestTransactionCreatedAtMs, createdAtMs);\n      }\n      const key = signalKey(row.wallet_address, row.token_mint);\n      if (pendingWork.has(key) || processedSignalKeys.has(key)) continue;\n      await processRecentBuy(row);\n    }\n    if (latestTransactionCreatedAtMs === 0) latestTransactionCreatedAtMs = Date.now();\n  } catch (error) {\n    console.error("[tiered-entry] recent pump isolated failure:", error);\n  } finally {\n    running = false;\n  }\n}`;

  source = replaceRequired(source, oldTick, newTick, "tiered incremental transaction poll");
  source = replaceRequired(
    source,
    "  setInterval(() => void tick(), 2_000);",
    "  setInterval(() => void tick(), TIERED_SIGNAL_POLL_MS);",
    "tiered poll interval"
  );

  writeFileSync(path, source);
}

function patchCompactPositionReads() {
  const replacements = [
    {
      path: "paper-trader/tieredEntryShadow.ts",
      from: '.select("*")\n        .order("entry_time", { ascending: true });',
      to: '.select("position_id,mint,token_symbol,entry_price,entry_time,size_sol,remaining_pct,peak_multiple,ladder_hits")\n        .order("entry_time", { ascending: true });',
    },
    {
      path: "paper-trader/momentumScalper.ts",
      from: '.from("scalp_positions").select("*").order("entry_time", { ascending: true });',
      to: '.from("scalp_positions").select("position_id,mint,token_symbol,pair_address,entry_price_usd,entry_time,size_sol,peak_price_usd").order("entry_time", { ascending: true });',
    },
  ];

  for (const item of replacements) {
    let source = readFileSync(item.path, "utf8");
    source = replaceRequired(source, item.from, item.to, `${item.path} compact position select`);
    writeFileSync(item.path, source);
  }
}

patchMonitor();
patchTieredRecentPump();
patchCompactPositionReads();
console.log("[startup-patch] Supabase reads optimized: incremental consensus, tiered dedup, compact position selects, wider configurable polling.");
