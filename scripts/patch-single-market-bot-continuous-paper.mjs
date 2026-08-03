import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[continuous-paper] missing ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  'const STRATEGY_VERSION = "market_timing_v3_2026_08_03";',
  'const STRATEGY_VERSION = "market_timing_v3_2026_08_03";\nconst CONTINUOUS_PAPER_TRADING = MODE === "paper";',
  "continuous-paper constant",
);

replaceOnce(
  "  const halted = dailyPnl <= -MAX_DAILY_LOSS_USDC;",
  "  const halted = CONTINUOUS_PAPER_TRADING ? false : dailyPnl <= -MAX_DAILY_LOSS_USDC;",
  "daily-loss halt",
);

replaceOnce(
  "    state = await maybeScalePaperBankroll(state);\n    const effectiveEnabled = ENABLED && state.enabled !== false;",
  "    state = await maybeScalePaperBankroll(state);\n    if (CONTINUOUS_PAPER_TRADING && state.halted) {\n      await patchState({ halted: false, halt_reason: null });\n      state = { ...state, halted: false, halt_reason: null };\n    }\n    const effectiveEnabled = ENABLED && state.enabled !== false;",
  "clear paper halt",
);

replaceOnce(
  "    if (!effectiveEnabled || state.halted || state.open_position || n(state.entries_today) >= MAX_DAILY_ENTRIES) {",
  "    if (!effectiveEnabled || (!CONTINUOUS_PAPER_TRADING && state.halted) || state.open_position || (!CONTINUOUS_PAPER_TRADING && n(state.entries_today) >= MAX_DAILY_ENTRIES)) {",
  "daily-entry and halt gate",
);

replaceOnce(
  "      maxDailyLossUsdc: MAX_DAILY_LOSS_USDC,",
  "      continuousPaperTrading: CONTINUOUS_PAPER_TRADING,\n      maxDailyLossUsdc: CONTINUOUS_PAPER_TRADING ? null : MAX_DAILY_LOSS_USDC,\n      maxDailyEntries: CONTINUOUS_PAPER_TRADING ? null : MAX_DAILY_ENTRIES,",
  "status configuration",
);

replaceOnce(
  "<div class=\"muted\" style=\"margin-top:8px\">Open position</div>",
  "<div class=\"muted\" style=\"margin-top:8px\">Overnight mode</div><div>Continuous paper trading · No daily loss or entry halt</div><div class=\"muted\" style=\"margin-top:8px\">Open position</div>",
  "dashboard overnight status",
);

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-continuous-paper] applied");
