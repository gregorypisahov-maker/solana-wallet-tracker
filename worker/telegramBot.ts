// worker/telegramBot.ts
//
// Inbound Telegram command listener using Telegram getUpdates long polling.
// Run as a separate Railway process from worker/monitor.ts.
//
// Security: commands are accepted only from TELEGRAM_CHAT_ID.

import 'dotenv/config';

import { sendTelegramAlert } from '../lib/telegram';
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

// Hard safety gate: only the dedicated Railway Telegram service may poll.
// Wallet Monitor and Web must leave this unset or set it to false.
if (!envFlag('ENABLE_TELEGRAM_POLLING')) {
  console.log('[telegram-bot] Polling disabled. Set ENABLE_TELEGRAM_POLLING=true only on the dedicated Telegram Bot & Alerts service.');
  process.exit(0);
}

// One token only. The same TELEGRAM_BOT_TOKEN is used for alerts and commands.
const TELEGRAM_BOT_TOKEN = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
const TELEGRAM_CHAT_ID = cleanEnv(process.env.TELEGRAM_CHAT_ID);

const POLL_TIMEOUT_SECONDS = 30;
const CONFLICT_BACKOFF_MIN_MS = 65_000;
const CONFLICT_BACKOFF_JITTER_MS = 30_000;
const TELEGRAM_WORKER_VERSION = '2026-07-17-elite-wallets-v9';

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
    chat: { id: number };
    text?: string;
  };
}

interface TelegramUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
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

const COMMAND_HANDLERS: Record<string, () => Promise<string>> = {
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
  if (incomingChatId !== TELEGRAM_CHAT_ID) {
    console.warn(`[telegram-bot] Ignored message from unauthorized chat ${incomingChatId}`);
    return;
  }

  const command = normalizeCommand(message.text);
  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    if (command.startsWith('/')) console.log(`[telegram-bot] Unknown command: ${command}`);
    return;
  }

  console.log(`[telegram-bot] Handling command: ${command}`);
  try {
    const response = await handler();
    await sendTelegramAlert(response);
  } catch (error) {
    console.error(`[telegram-bot] Command ${command} failed:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    await sendTelegramAlert(['❌ <b>Command failed</b>', '', `Command: ${command}`, `Error: ${errorMessage}`].join('\n'));
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
  console.log(`[telegram-bot] Bot-token fingerprint: ${tokenFingerprint}; chat configured: yes`);
  console.log('[telegram-bot] Commands ready: /paperstats /walletstats /exitstats /scorestats /heliusstats /readiness /resume /walletscan /auto_wallets /elite_wallets /discover_now /intelligence_now');

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
