// worker/telegramBot.ts
//
// NEW FILE — there was no inbound Telegram command listener anywhere in
// the project before this (lib/telegram.ts's sendTelegramAlert is
// outbound only). This uses Telegram's getUpdates long-polling API,
// which needs no public URL/webhook — it fits your existing
// worker-process model (Railway running a long-lived Node process) with
// no infra changes.
//
// Run this as a SEPARATE process from worker/monitor.ts (see deployment
// steps). It only reads state via analytics/walletPerformance/storage
// and replies to Telegram — it never touches the wallet-tracking or
// paper-trading logic itself.
//
// SECURITY: only responds to messages from TELEGRAM_CHAT_ID (the same
// chat ID your alerts already go to). Messages from any other chat are
// ignored and logged.

import 'dotenv/config';
import { sendTelegramAlert } from '../lib/telegram';
import {
  handlePaperStats,
  handleWalletStats,
  handleExitStats,
  handleScoreStats,
} from '../paper-trader/telegramCommands';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_TIMEOUT_SECONDS = 30; // long-poll timeout per Telegram getUpdates call

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error(
    '[telegram-bot] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set. Exiting.'
  );
  process.exit(1);
}

let lastUpdateId = 0;

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

async function getUpdates(): Promise<TelegramUpdate[]> {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates` +
    `?offset=${lastUpdateId + 1}&timeout=${POLL_TIMEOUT_SECONDS}`;

  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getUpdates failed: ${res.status} ${text}`);
  }

  const body = await res.json();
  return body.result ?? [];
}

const COMMAND_HANDLERS: Record<string, () => Promise<string>> = {
  '/paperstats': handlePaperStats,
  '/walletstats': handleWalletStats,
  '/exitstats': handleExitStats,
  '/scorestats': handleScoreStats,
};

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  lastUpdateId = Math.max(lastUpdateId, update.update_id);

  const message = update.message;
  if (!message?.text) return;

  const chatIdStr = String(message.chat.id);
  if (chatIdStr !== TELEGRAM_CHAT_ID) {
    console.warn(
      `[telegram-bot] Ignored message from unauthorized chat ${chatIdStr}`
    );
    return;
  }

  // Commands may arrive as "/paperstats" or "/paperstats@YourBotName" —
  // strip any @botname suffix before matching.
  const command = message.text.trim().split(' ')[0].split('@')[0].toLowerCase();

  const handler = COMMAND_HANDLERS[command];
  if (!handler) return; // not a recognized command, ignore silently

  console.log(`[telegram-bot] Handling command: ${command}`);

  try {
    const response = await handler();
    await sendTelegramAlert(response);
  } catch (err) {
    console.error(`[telegram-bot] Command ${command} failed:`, err);
    await sendTelegramAlert(
      `❌ <b>Command failed</b>\n\nCommand: ${command}\nError: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        await handleUpdate(update);
      }
    } catch (err) {
      console.error('[telegram-bot] Poll cycle failed:', err);
      // Back off briefly before retrying so a persistent network issue
      // doesn't spin in a tight loop.
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

console.log('[telegram-bot] Starting inbound command listener...');
pollLoop().catch((err) => {
  console.error('[telegram-bot] Fatal error:', err);
  process.exit(1);
});
