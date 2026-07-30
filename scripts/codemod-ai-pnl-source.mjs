import fs from "node:fs";

function patchFile(path, replacements) {
  let source = fs.readFileSync(path, "utf8");
  for (const [before, after, label] of replacements) {
    if (source.includes(after)) continue;
    const occurrences = source.split(before).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${path}: expected one ${label} match, found ${occurrences}`);
    }
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source);
}

patchFile("paper-trader/aiDiscoveryTrader.ts", [
  [
    'import { evaluateLiveEntrySafety } from "../live-executor/liveSafety";\n',
    'import { evaluateLiveEntrySafety } from "../live-executor/liveSafety";\nimport { maybeLogAiPnlHourlySummary } from "./aiPnlScoreboard";\n',
    "AI PnL import",
  ],
  [
    'const VERSION = "ai_discovery_trader_v1_9_shared_entry_safety_2026_07_28";',
    'const VERSION = "ai_discovery_trader_v2_2_lp_shadow_pnl_2026_07_30";',
    "worker version",
  ],
  [
    '    quoteExitAccounting: true,\n    entryQuote: entryQuote.quote,\n',
    '    quoteExitAccounting: true,\n    entryQuote: entryQuote.quote,\n    lp_lock: opportunity.entry_safety?.lp_lock ?? null,\n',
    "entry snapshot LP diagnostics",
  ],
  [
    '  void scanEntries().catch((error) =>\n',
    '  void maybeLogAiPnlHourlySummary();\n\n  void scanEntries().catch((error) =>\n',
    "initial PnL summary",
  ],
  [
    '  setInterval(\n    () =>\n      void trackCandidateOutcomes().catch((error) =>\n        console.error("[ai-discovery-trader] outcome tracking failed", error)\n      ),\n    60_000\n  );\n}',
    '  setInterval(\n    () =>\n      void trackCandidateOutcomes().catch((error) =>\n        console.error("[ai-discovery-trader] outcome tracking failed", error)\n      ),\n    60_000\n  );\n  setInterval(\n    () => void maybeLogAiPnlHourlySummary(),\n    60_000\n  );\n}',
    "hourly PnL schedule",
  ],
]);

patchFile("worker/telegramBot.ts", [
  [
    'import { handleAiStats } from "../paper-trader/aiDiscoveryStats";\n',
    'import { handleAiStats } from "../paper-trader/aiDiscoveryStats";\nimport { handleAiPnl } from "../paper-trader/aiPnlScoreboard";\n',
    "AI PnL command import",
  ],
  [
    'const TELEGRAM_WORKER_VERSION = "2026-07-30-network-resilient-polling";',
    'const TELEGRAM_WORKER_VERSION = "2026-07-30-network-resilient-ai-pnl";',
    "Telegram worker version",
  ],
  [
    '    "/aistats — AI discovery paper trading performance",\n',
    '    "/aistats — AI discovery paper trading performance",\n    "/ai_pnl [14d|30d|72h] — AI paper P&L scoreboard",\n',
    "help command",
  ],
  [
    '    [{ text: "🧠 AI Stats", callback_data: "/aistats" }, { text: "📉 Binance Paper", callback_data: "/binancestats" }],\n',
    '    [{ text: "🧠 AI Stats", callback_data: "/aistats" }, { text: "💰 AI PnL", callback_data: "/ai_pnl" }],\n    [{ text: "📉 Binance Paper", callback_data: "/binancestats" }],\n',
    "help keyboard",
  ],
  [
    'const COMMAND_HANDLERS: Record<string, () => Promise<string>> = {\n',
    'type CommandHandler = (args: string[]) => Promise<string>;\n\nconst COMMAND_HANDLERS: Record<string, CommandHandler> = {\n',
    "command handler type",
  ],
  [
    '  "/aidiscovery": handleAiStats,\n',
    '  "/aidiscovery": handleAiStats,\n  "/ai_pnl": (args) => handleAiPnl(args[0]),\n  "/aipnl": (args) => handleAiPnl(args[0]),\n',
    "AI PnL command routes",
  ],
  [
    'async function processCommand(incomingChatId: string, command: string): Promise<void> {\n',
    'async function processCommand(incomingChatId: string, rawText: string): Promise<void> {\n  const command = normalizeCommand(rawText);\n  const args = rawText.trim().split(/\\s+/).slice(1);\n',
    "command argument parsing",
  ],
  [
    '    const response = await handler();\n',
    '    const response = await handler(args);\n',
    "handler arguments",
  ],
  [
    '    const command = update.callback_query.data ? normalizeCommand(update.callback_query.data) : "";\n    if (chatId && command) await processCommand(chatId, command);\n',
    '    const rawText = update.callback_query.data ?? "";\n    if (chatId && rawText) await processCommand(chatId, rawText);\n',
    "callback raw command",
  ],
  [
    '  if (update.message?.text) await processCommand(String(update.message.chat.id), normalizeCommand(update.message.text));\n',
    '  if (update.message?.text) await processCommand(String(update.message.chat.id), update.message.text);\n',
    "message command arguments",
  ],
  [
    '  console.log("[telegram-bot] Helius commands ready: /helius_stats /helius_positions /helius_trades /helius_pnl /helius_credit /helius_pause /helius_resume");\n',
    '  console.log("[telegram-bot] Helius commands ready: /helius_stats /helius_positions /helius_trades /helius_pnl /helius_credit /helius_pause /helius_resume");\n  console.log("[telegram-bot] AI PnL command ready: /ai_pnl [14d|30d|72h]");\n',
    "AI PnL startup log",
  ],
]);

console.log("AI LP/PnL source codemod applied.");
