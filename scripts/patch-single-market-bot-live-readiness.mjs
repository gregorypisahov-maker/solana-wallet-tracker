import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(anchor, replacement, label) {
  if (!source.includes(anchor)) {
    throw new Error(`[live-readiness-patch] missing anchor: ${label}`);
  }
  source = source.replace(anchor, replacement);
}

if (source.includes("MARKET_LIVE_ARMED")) {
  console.log("[live-readiness-patch] already applied");
  process.exit(0);
}

replaceOnce(
  'const COOLDOWN_MINUTES = positiveInt("MARKET_REENTRY_COOLDOWN_MINUTES", 120);',
  `const COOLDOWN_MINUTES = positiveInt("MARKET_REENTRY_COOLDOWN_MINUTES", 120);\nconst LIVE_ARMED = process.env.MARKET_LIVE_ARMED === "true";\nconst LIVE_WALLET_PUBLIC_KEY = process.env.MARKET_LIVE_WALLET_PUBLIC_KEY?.trim() ?? "";\nconst LIVE_CONFIG_REFRESH_MS = positiveInt("MARKET_LIVE_CONFIG_REFRESH_MS", 15_000);\nlet liveConfigCache: { value: any; loadedAt: number } | null = null;`,
  "live constants"
);

replaceOnce(
  'async function patchState(values: Record<string, unknown>): Promise<void> {',
  `async function loadLiveConfig(force = false): Promise<any> {\n  if (!force && liveConfigCache && Date.now() - liveConfigCache.loadedAt < LIVE_CONFIG_REFRESH_MS) {\n    return liveConfigCache.value;\n  }\n  const { data, error } = await supabase\n    .from("live_trading_config")\n    .select("*")\n    .eq("id", 1)\n    .single();\n  if (error) throw new Error(\`live_config_unavailable: \${error.message}\`);\n  liveConfigCache = { value: data, loadedAt: Date.now() };\n  return data;\n}\n\nasync function liveReadiness(): Promise<{ ready: boolean; blockers: string[]; wallet: string; config: any; usdcBalance: number }> {\n  const blockers: string[] = [];\n  const wallet = getWalletPublicKey();\n  let config: any = null;\n  let usdcBalance = 0;\n  try {\n    config = await loadLiveConfig();\n  } catch (error) {\n    blockers.push(error instanceof Error ? error.message : String(error));\n  }\n  if (MODE !== "live") blockers.push("market_bot_mode_not_live");\n  if (!LIVE_ARMED) blockers.push("market_live_armed_false");\n  if (!LIVE_WALLET_PUBLIC_KEY) blockers.push("market_live_wallet_public_key_missing");\n  if (LIVE_WALLET_PUBLIC_KEY && wallet !== LIVE_WALLET_PUBLIC_KEY) blockers.push("wallet_allowlist_mismatch");\n  if (config) {\n    if (config.execution_enabled !== true) blockers.push("execution_enabled_false");\n    if (config.emergency_stop !== false) blockers.push("emergency_stop_active");\n    if (!config.wallet_public_key) blockers.push("database_wallet_public_key_missing");\n    if (config.wallet_public_key && config.wallet_public_key !== wallet) blockers.push("database_wallet_mismatch");\n    if (TRADE_SIZE_USDC > n(config.max_position_usd)) blockers.push("trade_size_exceeds_database_cap");\n    if (MAX_DAILY_LOSS_USDC > n(config.max_daily_loss_usd)) blockers.push("daily_loss_exceeds_database_cap");\n  }\n  try {\n    const balance = await getTokenBalanceRaw(USDC_MINT);\n    usdcBalance = usdcFromRaw(balance.amountRaw);\n    const reserve = n(config?.minimum_wallet_reserve_usd);\n    if (MODE === "live" && usdcBalance < TRADE_SIZE_USDC + reserve) blockers.push("insufficient_usdc_after_reserve");\n  } catch (error) {\n    blockers.push(\`wallet_balance_check_failed: \${error instanceof Error ? error.message : String(error)}\`);\n  }\n  return { ready: blockers.length === 0, blockers, wallet, config, usdcBalance };\n}\n\nasync function assertLiveEntryReady(): Promise<void> {\n  if (MODE !== "live") return;\n  const readiness = await liveReadiness();\n  if (!readiness.ready) throw new Error(\`live_not_ready: \${readiness.blockers.join(",")}\`);\n}\n\nasync function patchState(values: Record<string, unknown>): Promise<void> {`,
  "live readiness functions"
);

replaceOnce(
  '  const state = await loadState();\n  const validation = await validateRoundTrip(candidate);',
  '  const state = await loadState();\n  await assertLiveEntryReady();\n  const validation = await validateRoundTrip(candidate);',
  "entry readiness gate"
);

replaceOnce(
  `  if (MODE === "live") {\n    const result = await executeExactInSwap(USDC_MINT, candidate.mint, usdcRaw(TRADE_SIZE_USDC));\n    tokenAmountRaw = result.expectedOutputRaw;\n    entryTx = result.signature;\n  }`,
  `  if (MODE === "live") {\n    const before = await getTokenBalanceRaw(candidate.mint);\n    const result = await executeExactInSwap(USDC_MINT, candidate.mint, usdcRaw(TRADE_SIZE_USDC));\n    const after = await getTokenBalanceRaw(candidate.mint);\n    const received = BigInt(after.amountRaw) - BigInt(before.amountRaw);\n    if (received <= 0n) throw new Error("live_entry_balance_delta_zero");\n    tokenAmountRaw = received.toString();\n    entryTx = result.signature;\n  }`,
  "actual entry fill"
);

replaceOnce(
  `  if (MODE === "live") {\n    const balance = await getTokenBalanceRaw(position.mint);\n    if (BigInt(balance.amountRaw) <= 0n) throw new Error("position_token_balance_zero");\n    const result = await executeExactInSwap(position.mint, USDC_MINT, balance.amountRaw);\n    exitTx = result.signature;\n    exitUsdc = usdcFromRaw(result.expectedOutputRaw);\n  }`,
  `  if (MODE === "live") {\n    const tokenBalance = await getTokenBalanceRaw(position.mint);\n    if (BigInt(tokenBalance.amountRaw) <= 0n) throw new Error("position_token_balance_zero");\n    const usdcBefore = await getTokenBalanceRaw(USDC_MINT);\n    const result = await executeExactInSwap(position.mint, USDC_MINT, tokenBalance.amountRaw);\n    const usdcAfter = await getTokenBalanceRaw(USDC_MINT);\n    const received = BigInt(usdcAfter.amountRaw) - BigInt(usdcBefore.amountRaw);\n    if (received <= 0n) throw new Error("live_exit_balance_delta_zero");\n    exitTx = result.signature;\n    exitUsdc = usdcFromRaw(received);\n  }`,
  "actual exit fill"
);

replaceOnce(
  `      } catch (error) {\n        await patchState({ last_error: \`${'${candidate.symbol}'}: \${'${error instanceof Error ? error.message : String(error)}'}\` });\n      }`,
  `      } catch (error) {\n        const message = \`${'${candidate.symbol}'}: \${'${error instanceof Error ? error.message : String(error)}'}\`;\n        await patchState({ last_error: message });\n        if (MODE === "live") await telegram(\`🔴 LIVE entry rejected or failed\\n\${message}\`).catch(() => undefined);\n      }`,
  "live failure alert"
);

replaceOnce(
  'app.get("/api/status", async (_req: Request, res: Response) => {',
  `app.get("/api/live-readiness", async (_req: Request, res: Response) => {\n  try {\n    const readiness = await liveReadiness();\n    res.setHeader("cache-control", "no-store");\n    res.status(readiness.ready ? 200 : 503).json({\n      ...readiness,\n      mode: MODE,\n      envArmed: LIVE_ARMED,\n      configuredTradeSizeUsdc: TRADE_SIZE_USDC,\n      configuredDailyLossUsdc: MAX_DAILY_LOSS_USDC,\n    });\n  } catch (error) {\n    res.status(500).json({ ready: false, blockers: [error instanceof Error ? error.message : String(error)] });\n  }\n});\napp.get("/api/status", async (_req: Request, res: Response) => {`,
  "readiness endpoint"
);

replaceOnce(
  `async function bootstrap(): Promise<void> {\n  await patchState({`,
  `async function bootstrap(): Promise<void> {\n  if (MODE === "live") {\n    const readiness = await liveReadiness();\n    await telegram(readiness.ready\n      ? \`🟢 LIVE market bot ready\\nWallet: \${readiness.wallet}\\nUSDC: \${readiness.usdcBalance.toFixed(2)}\\nTrade size: \${TRADE_SIZE_USDC} USDC\`\n      : \`🟠 LIVE market bot NOT armed\\nBlockers: \${readiness.blockers.join(", ")}\`\n    ).catch(() => undefined);\n    if (!readiness.ready) {\n      await patchState({ enabled: false, mode: MODE, halted: true, halt_reason: \`live_not_ready: \${readiness.blockers.join(",")}\`, last_heartbeat_at: new Date().toISOString() });\n      return;\n    }\n  }\n  await patchState({`,
  "bootstrap live gate"
);

fs.writeFileSync(path, source);
console.log("[live-readiness-patch] applied");
