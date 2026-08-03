import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");
const req = (before, after, label) => {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[v3-core] missing ${label}`);
  source = source.replace(before, after);
};
const block = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`[v3-core] missing block ${start}`);
  return { a, b, text: source.slice(a, b) };
};

req('const TRADE_SIZE_USDC = positiveNumber("MARKET_TRADE_SIZE_USDC", 3);','const TRADE_SIZE_USDC = positiveNumber("MARKET_TRADE_SIZE_USDC", 100);','trade size');
req('const MAX_5M_CHANGE_PCT = positiveNumber("MARKET_MAX_5M_CHANGE_PCT", 2.50);','const MAX_5M_CHANGE_PCT = positiveNumber("MARKET_MAX_5M_CHANGE_PCT", 1.50);','chase cap');
req('const MAX_DAILY_LOSS_USDC = positiveNumber("MARKET_MAX_DAILY_LOSS_USDC", 1);','const MAX_DAILY_LOSS_USDC = positiveNumber("MARKET_MAX_DAILY_LOSS_USDC", 10);','daily loss');
req(
  'const COOLDOWN_MINUTES = positiveInt("MARKET_REENTRY_COOLDOWN_MINUTES", 120);',
  `const COOLDOWN_MINUTES = positiveInt("MARKET_REENTRY_COOLDOWN_MINUTES", 120);
const PAPER_SCALE_TARGET_USDC = positiveNumber("MARKET_PAPER_SCALE_TARGET_USDC", 1000);
const LOSS_BLOCK_COUNT = positiveInt("MARKET_LOSS_BLOCK_COUNT", 2);
const MAX_CONFIDENCE_MULTIPLIER = Math.min(10, positiveNumber("MARKET_MAX_CONFIDENCE_MULTIPLIER", 10));
const MAX_POSITION_PCT = Math.min(25, positiveNumber("MARKET_MAX_POSITION_PCT", 25));
const STATS_START_TRADE_ID = positiveInt("MARKET_STATS_START_TRADE_ID", 9);
const STRATEGY_VERSION = "market_timing_v3_2026_08_03";`,
  'v3 constants',
);
req('  entryTx: string | null;\n};','  entryTx: string | null;\n  currentExitUsdc?: number;\n  sizeMultiplier?: number;\n  confidenceTier?: string;\n};','position fields');

const patchStateEnd = `async function patchState(values: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from("single_market_bot_state")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", "main");
  if (error) throw error;
}`;
const helpers = `${patchStateEnd}

async function maybeScalePaperBankroll(state: any): Promise<any> {
  if (MODE !== "paper" || state.open_position) return state;
  const starting = n(state.starting_cash_usdc);
  if (starting <= 0 || starting >= PAPER_SCALE_TARGET_USDC * 0.999999) return state;
  const factor = PAPER_SCALE_TARGET_USDC / starting;
  const { error: backupError } = await supabase.from("single_market_bot_rollbacks").insert({
    label: \`pre_scale_\${starting.toFixed(6)}_to_\${PAPER_SCALE_TARGET_USDC.toFixed(2)}\`,
    state_snapshot: JSON.parse(JSON.stringify(state)),
    config_snapshot: { strategyVersion: STRATEGY_VERSION, tradeSizeUsdc: TRADE_SIZE_USDC, factor },
  });
  if (backupError) throw backupError;
  const { data, error } = await supabase.from("single_market_bot_state").update({
    starting_cash_usdc: PAPER_SCALE_TARGET_USDC,
    cash_usdc: n(state.cash_usdc) * factor,
    realized_pnl_usdc: n(state.realized_pnl_usdc) * factor,
    daily_realized_pnl_usdc: n(state.daily_realized_pnl_usdc) * factor,
    strategy_version: STRATEGY_VERSION,
    scale_applied_at: new Date().toISOString(),
    scale_factor: factor,
    scale_source_starting_cash_usdc: starting,
    updated_at: new Date().toISOString(),
  }).eq("id", "main").select("*").single();
  if (error) throw error;
  return data;
}

async function recentLossCount(mint: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase.from("single_market_bot_trades")
    .select("id", { count: "exact", head: true }).eq("mint", mint)
    .in("status", ["paper_closed", "closed"]).lt("pnl_usdc", 0).gte("updated_at", since);
  if (error) throw error;
  return Number(count ?? 0);
}

function confidenceSizing(candidate: Candidate, state: any) {
  const exceptional = candidate.score >= 108 && candidate.verified && candidate.organic >= 80 &&
    candidate.liquidity >= 5_000_000 && candidate.mcap >= 25_000_000 && candidate.holders >= 25_000 &&
    candidate.traders5m >= 100 && candidate.priceChange5m >= 0.25 && candidate.priceChange5m <= 0.75 &&
    candidate.priceChange1h >= 0.5 && candidate.priceChange1h <= 2 &&
    candidate.buyVolumeRatio5m >= 1.25 && candidate.buyVolumeRatio5m <= 6 &&
    candidate.priceChange24h >= 0 && candidate.liquidityChange24h >= 0;
  const strong = candidate.score >= 100 && candidate.verified && candidate.organic >= 60 &&
    candidate.liquidity >= 1_000_000 && candidate.traders5m >= 50 &&
    candidate.priceChange5m >= 0.25 && candidate.priceChange5m <= 0.9 &&
    candidate.priceChange1h >= 0.5 && candidate.priceChange1h <= 3 &&
    candidate.buyVolumeRatio5m >= 1.25 && candidate.buyVolumeRatio5m <= 10;
  const requested = MODE === "paper" && exceptional ? MAX_CONFIDENCE_MULTIPLIER : MODE === "paper" && strong ? 2 : 1;
  const tier = exceptional ? "exceptional" : strong ? "strong" : "normal";
  const cash = Math.max(0, n(state.cash_usdc));
  const size = Math.min(TRADE_SIZE_USDC * requested, cash * MAX_POSITION_PCT / 100, cash);
  return { tradeSizeUsdc: size, requestedMultiplier: requested, actualMultiplier: size / TRADE_SIZE_USDC, confidenceTier: tier };
}`;
req(patchStateEnd, helpers, 'helpers');

req('async function validateRoundTrip(candidate: Candidate): Promise<{ buyQuote: any; sellQuote: any; recoveryPct: number }> {','async function validateRoundTrip(candidate: Candidate, sizeUsdc: number): Promise<{ buyQuote: any; sellQuote: any; recoveryPct: number }> {','round trip signature');
let vr = block('async function validateRoundTrip(', '\n\nasync function openPosition');
let vrText = vr.text.replaceAll('TRADE_SIZE_USDC', 'sizeUsdc');
source = source.slice(0, vr.a) + vrText + source.slice(vr.b);

let op = block('async function openPosition(', '\n\nfunction exitReason');
let opText = op.text.replaceAll('TRADE_SIZE_USDC', 'tradeSizeUsdc');
opText = opText.replace(
  '  const state = await loadState();\n  const validation = await validateRoundTrip(candidate);',
  `  const state = await loadState();
  const priorLosses = await recentLossCount(candidate.mint);
  if (priorLosses >= LOSS_BLOCK_COUNT) throw new Error(\`loss_block_\${priorLosses}_in_24h\`);
  const sizing = confidenceSizing(candidate, state);
  const tradeSizeUsdc = sizing.tradeSizeUsdc;
  if (tradeSizeUsdc < Math.min(10, TRADE_SIZE_USDC)) throw new Error("insufficient_paper_cash_for_position");
  const validation = await validateRoundTrip(candidate, tradeSizeUsdc);`,
);
opText = opText.replace('      metadata: {\n        reasons:', '      metadata: {\n        strategyVersion: STRATEGY_VERSION,\n        priorLosses,\n        sizing,\n        reasons:');
opText = opText.replace('    entryTx,\n  };', '    entryTx,\n    currentExitUsdc: initialExitUsdc,\n    sizeMultiplier: sizing.actualMultiplier,\n    confidenceTier: sizing.confidenceTier,\n  };');
opText = opText.replace('    last_error: null,', '    strategy_version: STRATEGY_VERSION,\n    last_error: null,');
opText = opText.replace('Size: ${tradeSizeUsdc} USDC\\n5m:', 'Size: ${tradeSizeUsdc.toFixed(2)} USDC\\nConfidence: ${sizing.confidenceTier} · ${sizing.actualMultiplier.toFixed(2)}x sizing\\n5m:');
source = source.slice(0, op.a) + opText + source.slice(op.b);

req('    const state = await loadState();\n    const effectiveEnabled', '    let state = await loadState();\n    state = await maybeScalePaperBankroll(state);\n    const effectiveEnabled', 'scale before scan');
req('        strategyVersion: "market_timing_v2_2026_08_03",', '        strategyVersion: STRATEGY_VERSION,', 'snapshot version');
req('    const executableExitUsdc = await executableExitValue(position, price);\n    let positionChanged = false;', '    const executableExitUsdc = await executableExitValue(position, price);\n    let positionChanged = false;\n    position.currentExitUsdc = executableExitUsdc;\n    positionChanged = true;', 'current exit value');
req('    mode: MODE,\n    last_heartbeat_at:', '    mode: MODE,\n    strategy_version: STRATEGY_VERSION,\n    last_heartbeat_at:', 'bootstrap version');
source = source.replaceAll('market_timing_v2_2026_08_03', 'market_timing_v3_2026_08_03');

fs.writeFileSync(path, source);
console.log('[patch-single-market-bot-v3-core] applied');
