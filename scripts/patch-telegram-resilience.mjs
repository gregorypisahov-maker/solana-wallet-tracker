import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.cwd(), "worker/telegramBot.ts");
const original = fs.readFileSync(target, "utf8");

const replacement = `async function pollLoop(): Promise<void> {
  console.log(\`[telegram-bot] Starting inbound command listener (\${TELEGRAM_WORKER_VERSION})...\`);
  console.log("[telegram-bot] Commands ready: /paperstats /scalpstats /binancestats /walletstats /exitstats /scorestats /heliusstats /readiness /resume /resume_scalp");

  let startupFailures = 0;
  while (true) {
    try {
      await validateToken();
      break;
    } catch (error) {
      startupFailures += 1;
      const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(startupFailures - 1, 5));
      console.error(\`[telegram-bot] Telegram startup check failed; retrying in \${Math.round(backoff / 1000)}s:\`, error);
      await sleep(backoff);
    }
  }

  let consecutiveFailures = 0;
  while (true) {
    try {
      for (const update of await getUpdates()) await handleUpdate(update);
      consecutiveFailures = 0;
    } catch (error) {
      if (isTelegramConflict(error)) {
        const backoff = CONFLICT_BACKOFF_MIN_MS + Math.floor(Math.random() * CONFLICT_BACKOFF_JITTER_MS);
        console.warn(\`[telegram-bot] Another Telegram poller is active; retrying in \${Math.round(backoff / 1000)}s.\`);
        await sleep(backoff);
        continue;
      }

      consecutiveFailures += 1;
      const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(consecutiveFailures - 1, 5));
      console.error(\`[telegram-bot] Polling temporarily failed; retrying in \${Math.round(backoff / 1000)}s:\`, error);
      await sleep(backoff);
    }
  }
}

pollLoop().catch(async (error) => {
  console.error("[telegram-bot] Unexpected top-level error; keeping service alive:", error);
  while (true) await sleep(60_000);
});`;

const pattern = /async function pollLoop\(\): Promise<void> \{[\s\S]*?\n\}\n\npollLoop\(\)\.catch\([\s\S]*?\n\}\);\s*$/;

if (!pattern.test(original)) {
  if (original.includes("Polling temporarily failed; retrying in")) {
    console.log("[patch-telegram-resilience] Already applied.");
    process.exit(0);
  }
  throw new Error("Could not locate Telegram polling block; refusing to patch an unknown file shape.");
}

const updated = original
  .replace(pattern, replacement)
  .replace(
    /const TELEGRAM_WORKER_VERSION = "[^"]+";/,
    'const TELEGRAM_WORKER_VERSION = "2026-07-24-resilient-polling-v1";'
  );

fs.writeFileSync(target, updated, "utf8");
console.log("[patch-telegram-resilience] Applied resilient Telegram startup and polling retries.");
