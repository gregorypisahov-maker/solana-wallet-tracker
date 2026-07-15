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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 5_000;

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
    chat: {
      id: number;
    };
    text?: string;
  };
}

interface TelegramUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
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

    throw new Error(
      `Telegram getUpdates failed: ${response.status} ${text}`
    );
  }

  const body = (await response.json()) as TelegramUpdatesResponse;

  if (!body.ok) {
    throw new Error(
      body.description ?? 'Telegram getUpdates returned an unknown error'
    );
  }

  return body.result ?? [];
}

const COMMAND_HANDLERS: Record<string, () => Promise<string>> = {
  '/paperstats': handlePaperStats,
  '/walletstats': handleWalletStats,
  '/exitstats': handleExitStats,
  '/scorestats': handleScoreStats,
  '/heliusstats': handleHeliusStats,
  '/readiness': handleReadiness,
  '/resume': handleResume,
};

function normalizeCommand(text: string): string {
  return text
    .trim()
    .split(/\s+/)[0]
    .split('@')[0]
    .toLowerCase();
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  lastUpdateId = Math.max(lastUpdateId, update.update_id);

  const message = update.message;

  if (!message?.text) {
    return;
  }

  const incomingChatId = String(message.chat.id);

  if (incomingChatId !== TELEGRAM_CHAT_ID) {
    console.warn(
      `[telegram-bot] Ignored message from unauthorized chat ${incomingChatId}`
    );
    return;
  }

  const command = normalizeCommand(message.text);
  const handler = COMMAND_HANDLERS[command];

  if (!handler) {
    return;
  }

  console.log(`[telegram-bot] Handling command: ${command}`);

  try {
    const response = await handler();
    await sendTelegramAlert(response);
  } catch (error) {
    console.error(`[telegram-bot] Command ${command} failed:`, error);

    const errorMessage =
      error instanceof Error ? error.message : String(error);

    await sendTelegramAlert(
      [
        '❌ <b>Command failed</b>',
        '',
        `Command: ${command}`,
        `Error: ${errorMessage}`,
      ].join('\n')
    );
  }
}

async function pollLoop(): Promise<void> {
  console.log('[telegram-bot] Starting inbound command listener...');

  while (true) {
    try {
      const updates = await getUpdates();

      for (const update of updates) {
        await handleUpdate(update);
      }
    } catch (error) {
      console.error('[telegram-bot] Poll cycle failed:', error);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, RETRY_DELAY_MS);
      });
    }
  }
}

pollLoop().catch((error) => {
  console.error('[telegram-bot] Fatal error:', error);
  process.exit(1);
});
