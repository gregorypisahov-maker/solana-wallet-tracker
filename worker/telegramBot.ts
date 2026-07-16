// worker/telegramBot.ts
//
// Inbound Telegram command listener using Telegram getUpdates long polling.
// Run as a separate Railway process from worker/monitor.ts.
//
// Security: commands are accepted only from TELEGRAM_CHAT_ID and optional
// TELEGRAM_ALLOWED_CHAT_IDS entries.

import 'dotenv/config';

import { loadState } from '../paper-trader/storage';
import {
  handlePaperStats,
  handleWalletStats,
  handleExitStats,
  handleScoreStats,
  handleHeliusStats,
  handleReadiness,
  handleResume,
} from '../paper-trader/telegramCommands';
import { handleWalletScan } from './walletScanCommand';
import {
  handleAutoWallets,
  handleDiscoverNow,
  handleEliteWallets,
  handleIntelligenceNow,
} from './autoWalletCommands';

function cleanEnv(value: string | undefined): string {
  return (value ?? '').trim().replace(/^[\'\"]|[\'\"]$/g, '').trim();
}

function envFlag(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(cleanEnv(process.env[name]).toLowerCase());
}

if (!envFlag('ENABLE_TELEGRAM_POLLING')) {
  console.log('[telegram-bot] Polling disabled. Set ENABLE_TELEGRAM_POLLING=true only on the dedicated Telegram Bot & Alerts service.');
  process.exit(0);
}

const TELEGRAM_BOT_TOKEN = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
const TELEGRAM_CHAT_ID = cleanEnv(process.env.TELEGRAM_CHAT_ID);
const EXTRA_CHAT_IDS = cleanEnv(process.env.TELEGRAM_ALLOWED_CHAT_IDS)
  .split(/[\s,;]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const AUTHORIZED_CHAT_IDS = new Set([TELEGRAM_CHAT_ID, ...EXTRA_CHAT_IDS].filter(Boolean));

const POLL_TIMEOUT_SECONDS = 30;
const CONFLICT_BACKOFF_MIN_MS = 65_000;
const CONFLICT_BACKOFF_JITTER_MS = 30_000;
const TELEGRAM_WORKER_VERSION = '2026-07-17-chat-id-setup-v12';

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('[telegram-bot] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set. Exiting.');
  process.exit(1);
}

if (!/^\d+:[A-Za-z0-9_-]+$/.test(TELEGRAM_BOT_TOKEN)) {
  console.error('[telegram-bot] TELEGRAM_BOT_TOKEN has an invalid shape. It must look like 123456789:AA...');
  process.exit(1);
}

const tokenFingerprint = `${TELEGRAM_BOT_TOKEN.slice(0, 6)}…${TELEGRAM_BOT_TOKEN.slice(-4)}`;
let lastUpdateId = 0;

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; title?: string; type?: string };
    text?: string;
  };
}

interface TelegramUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

async function sendToChat(chatId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

async function validateToken(): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram rejected TELEGRAM_BOT_TOKEN (${tokenFingerprint}) during startup: ${response.status} ${text}`);
  }
  console.log(`[telegram-bot] Token accepted by Telegram (${tokenFingerprint}).`);
}

async function getUpdates(): Promise<TelegramUpdate[]> {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates` +
    `?offset=${lastUpdateId + 1}` +
    `&timeout=${POLL_TIMEOUT_SECONDS}` +
    `&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram getUpdates failed: ${response.status} ${text}`);
  }

  const body = (await response.json()) as TelegramUpdatesResponse;
  if (!body.ok) throw new Error(body.description ?? 'Telegram getUpdates returned an unknown error');
  return body.result ?? [];
}

async function handleHelp(): Promise<string> {
  let status = '🟡 Paper Trader: status unavailable';
  let resumeHint = '/resume — Resume paper trading if halted';

  try {
    const state = await loadState();
    if (state.halted) {
      status = `🔴 Paper Trader: HALTED${state.haltReason ? ` — ${state.haltReason}` : ''}`;
      resumeHint = '/resume — Resume paper trading now';
    } else {
      status = '🟢 Paper Trader: ACTIVE';
      resumeHint = '/resume — Not needed while active';
    }
  } catch (error) {
    console.warn('[telegram-bot] Help status check failed:', error);
  }

  return [
    '🤖 <b>SOLANA WALLET TRACKER</b>', '', status, '',
    '<b>📊 Status</b>',
    '/paperstats — Paper trading performance',
    '/readiness — Bot readiness check',
    '/heliusstats — Helius credit usage', '',
    '<b>📈 Analytics</b>',
    '/walletstats — Wallet performance',
    '/scorestats — Performance by score range',
    '/exitstats — Performance by exit reason',
    '/elite_wallets — Elite wallet rankings', '',
    '<b>🧠 Wallet intelligence</b>',
    '/auto_wallets — Automatic wallet-manager status',
    '/walletscan — Run wallet scan',
    '/discover_now — Search for new trial wallets now',
    '/intelligence_now — Re-score and rotate wallets now', '',
    '<b>🛠 Control</b>',
    resumeHint,
    '/help — Show this command menu',
    '/commands — Same as /help',
    '/chatid — Show this chat ID for setup',
  ].join('\n');
}

const COMMAND_HANDLERS: Record<string, () => Promise<string>> = {
  '/help': handleHelp,
  '/commands': handleHelp,
  '/start': handleHelp,
  '/paperstats': handlePaperStats,
  '/walletstats': handleWalletStats,
  '/exitstats': handleExitStats,
  '/scorestats': handleScoreStats,
  '/heliusstats': handleHeliusStats,
  '/helius_stats': handleHeliusStats,
  '/helius': handleHeliusStats,
  '/readiness': handleReadiness,
  '/resume': handleResume,
  '/walletscan': handleWalletScan,
  '/scanwallets': handleWalletScan,
  '/auto_wallets': handleAutoWallets,
  '/autowallets': handleAutoWallets,
  '/elite_wallets': handleEliteWallets,
  '/elitewallets': handleEliteWallets,
  '/discover_now': handleDiscoverNow,
  '/discovernow': handleDiscoverNow,
  '/intelligence_now': handleIntelligenceNow,
  '/intelligencenow': handleIntelligenceNow,
};

function normalizeCommand(text: string): string {
  return text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  lastUpdateId = Math.max(lastUpdateId, update.update_id);
  const message = update.message;
  if (!message?.text) return;

  const incomingChatId = String(message.chat.id);
  const command = normalizeCommand(message.text);

  if (command === '/chatid') {
    await sendToChat(incomingChatId, [
      '🆔 <b>Telegram chat ID</b>', '',
      `<code>${incomingChatId}</code>`, '',
      AUTHORIZED_CHAT_IDS.has(incomingChatId)
        ? '✅ This chat is already authorized.'
        : `⚠️ Add this Railway variable on the dedicated Telegram Bot service:\n\n<code>TELEGRAM_ALLOWED_CHAT_IDS=${incomingChatId}</code>\n\nThen redeploy.`,
    ].join('\n'));
    return;
  }

  if (!AUTHORIZED_CHAT_IDS.has(incomingChatId)) {
    console.warn(`[telegram-bot] Ignored message from unauthorized chat ${incomingChatId}`);
    if (command.startsWith('/')) {
      await sendToChat(incomingChatId, [
        '🔒 <b>This chat is not authorized yet.</b>', '',
        `Chat ID: <code>${incomingChatId}</code>`, '',
        'Add this exact Railway variable on the dedicated Telegram Bot service:', '',
        `<code>TELEGRAM_ALLOWED_CHAT_IDS=${incomingChatId}</code>`, '',
        'Then redeploy and send /help again.',
      ].join('\n'));
    }
    return;
  }

  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    if (command.startsWith('/')) {
      console.log(`[telegram-bot] Unknown command: ${command}`);
      await sendToChat(incomingChatId, `❓ Unknown command: ${command}\n\nUse /help to see all available commands.`);
    }
    return;
  }

  console.log(`[telegram-bot] Handling command ${command} from chat ${incomingChatId}`);
  try {
    const response = await handler();
    await sendToChat(incomingChatId, response);
  } catch (error) {
    console.error(`[telegram-bot] Command ${command} failed:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    await sendToChat(incomingChatId, ['❌ <b>Command failed</b>', '', `Command: ${command}`, `Error: ${errorMessage}`].join('\n'));
  }
}

function isTelegramConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('409') && message.toLowerCase().includes('conflict');
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function pollLoop(): Promise<void> {
  console.log(`[telegram-bot] Starting inbound command listener (${TELEGRAM_WORKER_VERSION})...`);
  console.log(`[telegram-bot] Bot-token fingerprint: ${tokenFingerprint}; authorized chats: ${AUTHORIZED_CHAT_IDS.size}`);
  console.log('[telegram-bot] Commands ready: /help /commands /chatid /paperstats /walletstats /exitstats /scorestats /heliusstats /readiness /resume /walletscan /auto_wallets /elite_wallets /discover_now /intelligence_now');

  await validateToken();

  while (true) {
    try {
      const updates = await getUpdates();
      for (const update of updates) await handleUpdate(update);
    } catch (error) {
      if (isTelegramConflict(error)) {
        const backoff = CONFLICT_BACKOFF_MIN_MS + Math.floor(Math.random() * CONFLICT_BACKOFF_JITTER_MS);
        console.warn(`[telegram-bot] Another poller owns this bot token; backing off ${Math.round(backoff / 1000)}s before retry.`);
        await sleep(backoff);
        continue;
      }
      console.error('[telegram-bot] Fatal polling error:', error);
      process.exit(1);
    }
  }
}

pollLoop().catch((error) => {
  console.error('[telegram-bot] Fatal startup error:', error);
  process.exit(1);
});