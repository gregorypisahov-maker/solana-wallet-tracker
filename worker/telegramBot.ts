import "dotenv/config";

import { loadState } from "../paper-trader/storage";
import {
  handlePaperStats,
  handleWalletStats,
  handleExitStats,
  handleScoreStats,
  handleHeliusStats,
  handleReadiness,
  handleResume,
  handleScalpStats,
} from "../paper-trader/telegramCommands";
import { handleTieredStats } from "../paper-trader/tieredStats";
import { handleWalletScan } from "./walletScanCommand";
import {
  handleAutoWallets,
  handleDiscoverNow,
  handleEliteWallets,
  handleIntelligenceNow,
} from "./autoWalletCommands";
import { resumeScalper } from "./scalpResume";

function cleanEnv(value: string | undefined): string {
  return (value ?? "").trim().replace(/^[\'\"]|[\'\"]$/g, "").trim();
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(cleanEnv(process.env[name]).toLowerCase());
}

if (!envFlag("ENABLE_TELEGRAM_POLLING")) {
  console.log("[telegram-bot] Polling disabled. Set ENABLE_TELEGRAM_POLLING=true only on the dedicated Telegram Bot & Alerts service.");
  process.exit(0);
}

const TELEGRAM_BOT_TOKEN = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
const TELEGRAM_CHAT_ID = cleanEnv(process.env.TELEGRAM_CHAT_ID);
const VERIFIED_DASHBOARD_URL = "https://solana-wallet-tracker-murex.vercel.app";
const configuredDashboardUrl = cleanEnv(
  process.env.DASHBOARD_URL ??
  process.env.COMMAND_CENTER_URL ??
  process.env.NEXT_PUBLIC_DASHBOARD_URL
);
const DASHBOARD_URL =
  !configuredDashboardUrl ||
  /^https:\/\/wallet-tracker-murex\.vercel\.app(?:[/?#]|$)/i.test(configuredDashboardUrl)
    ? VERIFIED_DASHBOARD_URL
    : configuredDashboardUrl;
const EXTRA_CHAT_IDS = cleanEnv(process.env.TELEGRAM_ALLOWED_CHAT_IDS)
  .split(/[\s,;]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const AUTHORIZED_CHAT_IDS = new Set([TELEGRAM_CHAT_ID, ...EXTRA_CHAT_IDS].filter(Boolean));
const POLL_TIMEOUT_SECONDS = 30;
const CONFLICT_BACKOFF_MIN_MS = 65_000;
const CONFLICT_BACKOFF_JITTER_MS = 30_000;
const TELEGRAM_WORKER_VERSION = "2026-07-21-tiered-shadow-v1";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("[telegram-bot] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set. Exiting.");
  process.exit(1);
}
if (!/^\d+:[A-Za-z0-9_-]+$/.test(TELEGRAM_BOT_TOKEN)) {
  console.error("[telegram-bot] TELEGRAM_BOT_TOKEN has an invalid shape.");
  process.exit(1);
}

const tokenFingerprint = `${TELEGRAM_BOT_TOKEN.slice(0, 6)}…${TELEGRAM_BOT_TOKEN.slice(-4)}`;
let lastUpdateId = 0;

interface TelegramMessage {
  chat: { id: number; title?: string; type?: string };
  text?: string;
}
interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
interface TelegramUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}
type InlineButton = { text: string; callback_data?: string; url?: string };
type InlineKeyboard = { inline_keyboard: InlineButton[][] };

async function sendToChat(chatId: string, text: string, replyMarkup?: InlineKeyboard): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
}

async function answerCallback(callbackQueryId: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch (error) {
    console.warn("[telegram-bot] Could not acknowledge callback:", error);
  }
}

async function validateToken(): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
  const text = await response.text();
  if (!response.ok) throw new Error(`Telegram rejected token (${tokenFingerprint}): ${response.status} ${text}`);
  console.log(`[telegram-bot] Token accepted by Telegram (${tokenFingerprint}).`);
}

async function getUpdates(): Promise<TelegramUpdate[]> {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates` +
    `?offset=${lastUpdateId + 1}` +
    `&timeout=${POLL_TIMEOUT_SECONDS}` +
    `&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram getUpdates failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as TelegramUpdatesResponse;
  if (!body.ok) throw new Error(body.description ?? "Telegram getUpdates failed");
  return body.result ?? [];
}

async function handleResumeScalper(): Promise<string> {
  const result = await resumeScalper();
  if (!result.success) throw new Error(result.message);
  return ["▶️ <b>SCALP BOT RESUMED</b>", "", result.message, "Scanning: ACTIVE", "New paper scalp entries: ENABLED"].join("\n");
}

async function handleHelp(): Promise<string> {
  let status = "🟡 Paper Trader: status unavailable";
  let resumeHint = "/resume — Resume paper trading if halted";
  try {
    const state = await loadState();
    if (state.halted) {
      status = `🔴 Paper Trader: HALTED${state.haltReason ? ` — ${state.haltReason}` : ""}`;
      resumeHint = "/resume — Resume paper trading now";
    } else {
      status = "🟢 Paper Trader: ACTIVE";
      resumeHint = "/resume — Not needed while active";
    }
  } catch (error) {
    console.warn("[telegram-bot] Help status check failed:", error);
  }

  return [
    "🤖 <b>SOLANA WALLET TRACKER</b>", "", status, "",
    "<b>📊 Status</b>",
    "/paperstats — Wallet-based paper trading performance",
    "/scalpstats — Parallel momentum scalper performance",
    "/tieredstats — First-buy tiered shadow performance",
    "/readiness — Bot readiness check",
    "/heliusstats — Helius credit usage", "",
    "<b>📈 Analytics</b>",
    "/walletstats — Wallet performance",
    "/scorestats — Performance by score range",
    "/exitstats — Performance by exit reason",
    "/elite_wallets — Elite wallet rankings", "",
    "<b>🧠 Wallet intelligence</b>",
    "/auto_wallets — Automatic wallet-manager status",
    "/walletscan — Run wallet scan",
    "/discover_now — Search for new trial wallets now",
    "/intelligence_now — Re-score and rotate wallets now", "",
    "<b>🛠 Control</b>",
    resumeHint,
    "/resume_scalp — Resume the momentum scalp bot",
    "/help — Show this command menu", "",
    "<b>🌐 Command Center</b>",
    /^https:\/\//i.test(DASHBOARD_URL) ? `<a href="${DASHBOARD_URL}">Open the live dashboard</a>` : "Dashboard unavailable",
  ].join("\n");
}

function helpKeyboard(): InlineKeyboard {
  const rows: InlineButton[][] = [];
  if (/^https:\/\//i.test(DASHBOARD_URL)) rows.push([{ text: "🌐 Command Center", url: DASHBOARD_URL }]);
  rows.push(
    [{ text: "📊 Paper Stats", callback_data: "/paperstats" }, { text: "⚡ Scalp Stats", callback_data: "/scalpstats" }],
    [{ text: "🪜 Tiered Stats", callback_data: "/tieredstats" }, { text: "✅ Readiness", callback_data: "/readiness" }],
    [{ text: "▶️ Resume Paper", callback_data: "/resume" }, { text: "⚡ Resume Scalp", callback_data: "/resume_scalp" }],
    [{ text: "🧠 Auto Wallets", callback_data: "/auto_wallets" }, { text: "🔄 Wallet Scan", callback_data: "/walletscan" }],
  );
  return { inline_keyboard: rows };
}

const COMMAND_HANDLERS: Record<string, () => Promise<string>> = {
  "/help": handleHelp,
  "/commands": handleHelp,
  "/start": handleHelp,
  "/paperstats": handlePaperStats,
  "/scalpstats": handleScalpStats,
  "/scalp_stats": handleScalpStats,
  "/scalper": handleScalpStats,
  "/tieredstats": handleTieredStats,
  "/tiered_stats": handleTieredStats,
  "/walletstats": handleWalletStats,
  "/exitstats": handleExitStats,
  "/scorestats": handleScoreStats,
  "/heliusstats": handleHeliusStats,
  "/helius_stats": handleHeliusStats,
  "/helius": handleHeliusStats,
  "/readiness": handleReadiness,
  "/resume": handleResume,
  "/resume_scalp": handleResumeScalper,
  "/resumescalp": handleResumeScalper,
  "/resume_scalper": handleResumeScalper,
  "/walletscan": handleWalletScan,
  "/scanwallets": handleWalletScan,
  "/auto_wallets": handleAutoWallets,
  "/autowallets": handleAutoWallets,
  "/elite_wallets": handleEliteWallets,
  "/elitewallets": handleEliteWallets,
  "/discover_now": handleDiscoverNow,
  "/discovernow": handleDiscoverNow,
  "/intelligence_now": handleIntelligenceNow,
  "/intelligencenow": handleIntelligenceNow,
};

function normalizeCommand(text: string): string {
  return text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
}

async function processCommand(incomingChatId: string, command: string): Promise<void> {
  if (command === "/chatid") {
    await sendToChat(incomingChatId, [
      "🆔 <b>Telegram chat ID</b>", "", `<code>${incomingChatId}</code>`, "",
      AUTHORIZED_CHAT_IDS.has(incomingChatId)
        ? "✅ This chat is already authorized."
        : `⚠️ Add this Railway variable:\n\n<code>TELEGRAM_ALLOWED_CHAT_IDS=${incomingChatId}</code>`,
    ].join("\n"));
    return;
  }
  if (!AUTHORIZED_CHAT_IDS.has(incomingChatId)) {
    console.warn(`[telegram-bot] Ignored message from unauthorized chat ${incomingChatId}`);
    if (command.startsWith("/")) await sendToChat(incomingChatId, `🔒 Unauthorized chat.\n\nChat ID: <code>${incomingChatId}</code>`);
    return;
  }
  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    if (command.startsWith("/")) await sendToChat(incomingChatId, `❓ Unknown command: ${command}\n\nUse /help.`);
    return;
  }
  try {
    const response = await handler();
    const isHelp = command === "/help" || command === "/commands" || command === "/start";
    await sendToChat(incomingChatId, response, isHelp ? helpKeyboard() : undefined);
  } catch (error) {
    console.error(`[telegram-bot] Command ${command} failed:`, error);
    await sendToChat(incomingChatId, `❌ <b>Command failed</b>\n\nCommand: ${command}\nError: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  lastUpdateId = Math.max(lastUpdateId, update.update_id);
  if (update.callback_query) {
    await answerCallback(update.callback_query.id);
    const chatId = update.callback_query.message ? String(update.callback_query.message.chat.id) : "";
    const command = update.callback_query.data ? normalizeCommand(update.callback_query.data) : "";
    if (chatId && command) await processCommand(chatId, command);
    return;
  }
  if (update.message?.text) await processCommand(String(update.message.chat.id), normalizeCommand(update.message.text));
}

function isTelegramConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("409") && message.toLowerCase().includes("conflict");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function pollLoop(): Promise<void> {
  console.log(`[telegram-bot] Starting inbound command listener (${TELEGRAM_WORKER_VERSION})...`);
  console.log("[telegram-bot] Commands ready: /paperstats /scalpstats /tieredstats /walletstats /exitstats /scorestats /heliusstats /readiness /resume /resume_scalp");
  await validateToken();
  while (true) {
    try {
      for (const update of await getUpdates()) await handleUpdate(update);
    } catch (error) {
      if (isTelegramConflict(error)) {
        const backoff = CONFLICT_BACKOFF_MIN_MS + Math.floor(Math.random() * CONFLICT_BACKOFF_JITTER_MS);
        await sleep(backoff);
        continue;
      }
      console.error("[telegram-bot] Fatal polling error:", error);
      process.exit(1);
    }
  }
}

pollLoop().catch((error) => {
  console.error("[telegram-bot] Fatal startup error:", error);
  process.exit(1);
});
