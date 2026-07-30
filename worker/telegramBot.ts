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
import {
  handleHeliusCredit,
  handleHeliusFlowStats,
  handleHeliusPause,
  handleHeliusPnl,
  handleHeliusPositions,
  handleHeliusResume,
  handleHeliusTrades,
} from "../paper-trader/heliusTelegramCommands";
import { handleAiStats } from "../paper-trader/aiDiscoveryStats";
import {
  handleAiPnl,
  maybeLogAiPnlHourlySummary,
} from "../paper-trader/aiPnlScoreboard";
import { handleBinanceFuturesStats } from "../paper-trader/binanceFuturesStats";
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
const POLL_TIMEOUT_SECONDS = 8;
const CONFLICT_BACKOFF_MIN_MS = 65_000;
const CONFLICT_BACKOFF_JITTER_MS = 30_000;
const TELEGRAM_FETCH_TIMEOUT_MS = 10_000;
const TELEGRAM_FETCH_MAX_ATTEMPTS = 5;
const TELEGRAM_WARNING_INTERVAL_MS = 30_000;
const TELEGRAM_WORKER_VERSION = "2026-07-30-network-resilient-ai-pnl";

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
let tokenValidated = false;
let nextTokenValidationAt = 0;

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
interface TelegramApiEnvelope<T = unknown> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}
type InlineButton = { text: string; callback_data?: string; url?: string };
type InlineKeyboard = { inline_keyboard: InlineButton[][] };
type TelegramFetchResult<T> = {
  status: number;
  responseOk: boolean;
  body: T | string | null;
};

const RETRYABLE_TELEGRAM_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const warningState = new Map<string, { count: number; lastLoggedAt: number }>();

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function networkErrorCode(error: unknown): string | null {
  const candidate = error as {
    name?: string;
    message?: string;
    cause?: { name?: string; code?: string; message?: string };
  };
  if (candidate?.name === "AbortError" || candidate?.cause?.name === "AbortError") {
    return "AbortError";
  }
  const code = candidate?.cause?.code;
  if (code && RETRYABLE_TELEGRAM_NETWORK_CODES.has(code)) return code;
  const message = `${candidate?.message ?? ""} ${candidate?.cause?.message ?? ""}`.toLowerCase();
  return message.includes("fetch failed") ? "FETCH_FAILED" : null;
}

function warnCollapsed(key: string, message: string, intervalMs = TELEGRAM_WARNING_INTERVAL_MS): void {
  const now = Date.now();
  const state = warningState.get(key) ?? { count: 0, lastLoggedAt: 0 };
  state.count += 1;
  if (state.lastLoggedAt === 0 || now - state.lastLoggedAt >= intervalMs) {
    console.warn(`${message} (occurrences=${state.count})`);
    state.count = 0;
    state.lastLoggedAt = now;
  }
  warningState.set(key, state);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function parseTelegramBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchTelegram<T = TelegramApiEnvelope>(
  url: string,
  options: RequestInit = {}
): Promise<TelegramFetchResult<T> | null> {
  for (let attempt = 1; attempt <= TELEGRAM_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return {
        status: response.status,
        responseOk: response.ok,
        body: (await parseTelegramBody(response)) as T | string | null,
      };
    } catch (error) {
      const code = networkErrorCode(error);
      if (!code) {
        warnCollapsed(
          "telegram-fetch-unexpected",
          `[telegram-bot] Telegram request failed without retry: ${compactError(error)}`
        );
        return null;
      }

      warnCollapsed(
        `telegram-network-${code}`,
        `[telegram-bot] Telegram network unavailable (${code}); retrying attempt ${attempt}/${TELEGRAM_FETCH_MAX_ATTEMPTS}`
      );
      if (attempt >= TELEGRAM_FETCH_MAX_ATTEMPTS) return null;

      const baseDelayMs = Math.min(8_000, 500 * 2 ** (attempt - 1));
      const jitterMs = Math.floor(Math.random() * Math.max(100, Math.floor(baseDelayMs * 0.25)));
      await sleep(baseDelayMs + jitterMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

function envelopeFrom<T>(result: TelegramFetchResult<TelegramApiEnvelope<T>>): TelegramApiEnvelope<T> | null {
  return result.body && typeof result.body === "object"
    ? result.body as TelegramApiEnvelope<T>
    : null;
}

async function sendToChat(chatId: string, text: string, replyMarkup?: InlineKeyboard): Promise<void> {
  const result = await fetchTelegram<TelegramApiEnvelope>(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    }
  );
  if (!result) {
    warnCollapsed("telegram-send-deferred", "[telegram-bot] sendMessage deferred: network unavailable");
    return;
  }
  const body = envelopeFrom(result);
  if (!result.responseOk || body?.ok !== true) {
    warnCollapsed(
      `telegram-send-http-${result.status}`,
      `[telegram-bot] sendMessage rejected: HTTP ${result.status} ${body?.description ?? "unknown response"}`
    );
  }
}

async function answerCallback(callbackQueryId: string): Promise<void> {
  const result = await fetchTelegram<TelegramApiEnvelope>(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    }
  );
  if (!result) {
    warnCollapsed("telegram-callback-deferred", "[telegram-bot] callback acknowledgement deferred: network unavailable");
    return;
  }
  const body = envelopeFrom(result);
  if (!result.responseOk || body?.ok !== true) {
    warnCollapsed(
      `telegram-callback-http-${result.status}`,
      `[telegram-bot] callback acknowledgement rejected: HTTP ${result.status} ${body?.description ?? "unknown response"}`
    );
  }
}

async function validateToken(): Promise<void> {
  const result = await fetchTelegram<TelegramApiEnvelope<{ id: number }>>(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`
  );
  if (!result) {
    tokenValidated = false;
    nextTokenValidationAt = Date.now() + TELEGRAM_WARNING_INTERVAL_MS;
    warnCollapsed(
      "telegram-token-validation-deferred",
      "[telegram-bot] token validation deferred: network unavailable, will retry"
    );
    return;
  }

  const body = envelopeFrom(result);
  if (!result.responseOk || body?.ok !== true) {
    tokenValidated = false;
    nextTokenValidationAt = Date.now() + TELEGRAM_WARNING_INTERVAL_MS;
    warnCollapsed(
      `telegram-token-validation-http-${result.status}`,
      `[telegram-bot] token validation rejected: HTTP ${result.status} ${body?.description ?? "unknown response"}`
    );
    return;
  }

  if (!tokenValidated) {
    console.log(`[telegram-bot] Token accepted by Telegram (${tokenFingerprint}).`);
  }
  tokenValidated = true;
  nextTokenValidationAt = Number.POSITIVE_INFINITY;
}

async function getUpdates(): Promise<TelegramUpdate[]> {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates` +
    `?offset=${lastUpdateId + 1}` +
    `&timeout=${POLL_TIMEOUT_SECONDS}` +
    `&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`;
  const result = await fetchTelegram<TelegramApiEnvelope<TelegramUpdate[]>>(url);
  if (!result) {
    warnCollapsed(
      "telegram-poll-network-unavailable",
      "[telegram-bot] polling paused: Telegram network unavailable; will retry automatically"
    );
    return [];
  }

  const body = envelopeFrom(result);
  if (result.status === 409) {
    const backoff = CONFLICT_BACKOFF_MIN_MS + Math.floor(Math.random() * CONFLICT_BACKOFF_JITTER_MS);
    warnCollapsed(
      "telegram-poll-conflict",
      `[telegram-bot] getUpdates conflict; another poller may be active, backing off ${Math.round(backoff / 1000)}s`
    );
    await sleep(backoff);
    return [];
  }

  if (result.status === 429) {
    const retrySeconds = Math.max(1, Number(body?.parameters?.retry_after) || 5);
    warnCollapsed(
      "telegram-poll-rate-limit",
      `[telegram-bot] Telegram rate limited getUpdates; retrying in ${retrySeconds}s`
    );
    await sleep(retrySeconds * 1_000);
    return [];
  }

  if (!result.responseOk || body?.ok !== true) {
    warnCollapsed(
      `telegram-poll-http-${result.status}`,
      `[telegram-bot] getUpdates rejected: HTTP ${result.status} ${body?.description ?? "unknown response"}`
    );
    await sleep(2_000);
    return [];
  }

  return Array.isArray(body.result) ? body.result : [];
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
    "/aistats — AI discovery paper trading performance",
    "/ai_pnl [14d|30d|72h] — AI paper P&L scoreboard",
    "/binancestats — BTCUSDT futures paper bot",
    "/readiness — Bot readiness check",
    "/heliusstats — Existing Helius monitor usage", "",
    "<b>🧠 Helius flow paper</b>",
    "/helius_stats — Intelligence worker and paper status",
    "/helius_positions — Open Helius paper positions",
    "/helius_trades — Last 10 closed Helius paper trades",
    "/helius_pnl — Helius paper bankroll and performance",
    "/helius_credit — Intelligence credit usage",
    "/helius_pause — Pause new Helius paper entries",
    "/helius_resume — Resume Helius paper entries", "",
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
    [{ text: "🧠 AI Stats", callback_data: "/aistats" }, { text: "💰 AI PnL", callback_data: "/ai_pnl" }],
    [{ text: "📉 Binance Paper", callback_data: "/binancestats" }],
    [{ text: "🧠 Helius Flow", callback_data: "/helius_stats" }, { text: "💰 Helius PnL", callback_data: "/helius_pnl" }],
    [{ text: "✅ Readiness", callback_data: "/readiness" }],
    [{ text: "▶️ Resume Paper", callback_data: "/resume" }, { text: "⚡ Resume Scalp", callback_data: "/resume_scalp" }],
    [{ text: "🧠 Auto Wallets", callback_data: "/auto_wallets" }, { text: "🔄 Wallet Scan", callback_data: "/walletscan" }],
  );
  return { inline_keyboard: rows };
}

type CommandHandler = (args: string[]) => Promise<string>;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  "/help": handleHelp,
  "/commands": handleHelp,
  "/start": handleHelp,
  "/paperstats": handlePaperStats,
  "/scalpstats": handleScalpStats,
  "/scalp_stats": handleScalpStats,
  "/scalper": handleScalpStats,
  "/aistats": handleAiStats,
  "/ai_stats": handleAiStats,
  "/aidiscovery": handleAiStats,
  "/ai_pnl": (args) => handleAiPnl(args[0]),
  "/aipnl": (args) => handleAiPnl(args[0]),
  "/binancestats": handleBinanceFuturesStats,
  "/binance_stats": handleBinanceFuturesStats,
  "/futuresstats": handleBinanceFuturesStats,
  "/walletstats": handleWalletStats,
  "/exitstats": handleExitStats,
  "/scorestats": handleScoreStats,
  "/heliusstats": handleHeliusStats,
  "/helius": handleHeliusStats,
  "/helius_stats": handleHeliusFlowStats,
  "/helius_positions": handleHeliusPositions,
  "/heliuspositions": handleHeliusPositions,
  "/helius_trades": handleHeliusTrades,
  "/heliustrades": handleHeliusTrades,
  "/helius_pnl": handleHeliusPnl,
  "/heliuspnl": handleHeliusPnl,
  "/helius_credit": handleHeliusCredit,
  "/heliuscredit": handleHeliusCredit,
  "/helius_pause": handleHeliusPause,
  "/heliuspause": handleHeliusPause,
  "/helius_resume": handleHeliusResume,
  "/heliusresume": handleHeliusResume,
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

async function processCommand(incomingChatId: string, rawText: string): Promise<void> {
  const command = normalizeCommand(rawText);
  const args = rawText.trim().split(/\s+/).slice(1);
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
    const response = await handler(args);
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
    const rawText = update.callback_query.data ?? "";
    if (chatId && rawText) await processCommand(chatId, rawText);
    return;
  }
  if (update.message?.text) await processCommand(String(update.message.chat.id), update.message.text);
}

async function pollLoop(): Promise<void> {
  console.log(`[telegram-bot] Starting inbound command listener (${TELEGRAM_WORKER_VERSION})...`);
  console.log("[telegram-bot] Helius commands ready: /helius_stats /helius_positions /helius_trades /helius_pnl /helius_credit /helius_pause /helius_resume");
  console.log("[telegram-bot] AI PnL command ready: /ai_pnl [14d|30d|72h]");
  await validateToken();

  while (true) {
    try {
      if (!tokenValidated && Date.now() >= nextTokenValidationAt) {
        await validateToken();
      }
      const updates = await getUpdates();
      for (const update of updates) {
        try {
          await handleUpdate(update);
        } catch (error) {
          warnCollapsed(
            "telegram-update-handler",
            `[telegram-bot] update handler failed: ${compactError(error)}; continuing`
          );
        }
      }
    } catch (error) {
      warnCollapsed(
        "telegram-poll-iteration",
        `[telegram-bot] polling iteration failed: ${compactError(error)}; backing off and continuing`
      );
      await sleep(2_000);
    }
  }
}

async function runPollingSupervisor(): Promise<void> {
  while (true) {
    try {
      await pollLoop();
    } catch (error) {
      warnCollapsed(
        "telegram-poll-supervisor",
        `[telegram-bot] polling loop stopped unexpectedly: ${compactError(error)}; restarting in 5s`
      );
      await sleep(5_000);
    }
  }
}

void maybeLogAiPnlHourlySummary();
setInterval(() => void maybeLogAiPnlHourlySummary(), 60_000);
void runPollingSupervisor();
