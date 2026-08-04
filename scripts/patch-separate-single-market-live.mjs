import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

function mustReplace(before, after, label) {
  if (!source.includes(before)) throw new Error(`[separate-live] missing ${label}`);
  source = source.replace(before, after);
}

mustReplace(
  'const MODE = process.env.MARKET_BOT_MODE === "live" ? "live" : "paper";',
  'const MODE = "live" as const;\nconst LIVE_ARMED = process.env.MARKET_LIVE_ARMED === "true";\nconst LIVE_WALLET_PUBLIC_KEY = process.env.MARKET_LIVE_WALLET_PUBLIC_KEY?.trim() ?? "";',
  "mode",
);

source = source.replaceAll('"single_market_bot_state"', '"single_market_live_bot_state"');
source = source.replaceAll('"single_market_bot_trades"', '"single_market_live_bot_trades"');
source = source.replaceAll('single-market-bot', 'single-market-live-bot');
source = source.replaceAll('Solana Market Bot', 'Solana Market Live Bot');
source = source.replaceAll('Market bot ${MODE.toUpperCase()}', 'Market LIVE');

mustReplace(
  'async function openPosition(candidate: Candidate): Promise<void> {\n  const state = await loadState();',
  `async function openPosition(candidate: Candidate): Promise<void> {\n  const state = await loadState();\n  const wallet = getWalletPublicKey();\n  if (!LIVE_ARMED) throw new Error("live_not_armed");\n  if (!LIVE_WALLET_PUBLIC_KEY) throw new Error("live_wallet_allowlist_missing");\n  if (wallet !== LIVE_WALLET_PUBLIC_KEY) throw new Error("live_wallet_allowlist_mismatch");`,
  "entry gate",
);

mustReplace(
  'async function bootstrap(): Promise<void> {\n  await patchState({',
  `async function bootstrap(): Promise<void> {\n  const wallet = getWalletPublicKey();\n  const startupBlocker = !LIVE_ARMED ? "live_not_armed" : !LIVE_WALLET_PUBLIC_KEY ? "live_wallet_allowlist_missing" : wallet !== LIVE_WALLET_PUBLIC_KEY ? "live_wallet_allowlist_mismatch" : null;\n  if (startupBlocker) {\n    await patchState({ enabled: false, mode: MODE, halted: true, halt_reason: startupBlocker, last_heartbeat_at: new Date().toISOString() });\n    await telegram(\`🟠 Separate LIVE bot blocked\\nReason: \${startupBlocker}\\nWallet: \${wallet}\`).catch(() => undefined);\n    return;\n  }\n  await patchState({`,
  "startup gate",
);

source = source.replace(
  'config: { enabled: ENABLED, mode: MODE, tradeSizeUsdc: TRADE_SIZE_USDC }',
  'config: { enabled: ENABLED, mode: MODE, armed: LIVE_ARMED, tradeSizeUsdc: TRADE_SIZE_USDC }',
);

fs.writeFileSync(path, source);
console.log("[patch-separate-single-market-live] applied");
