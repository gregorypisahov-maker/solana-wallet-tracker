import { loadState, saveState } from "../paper-trader/storage";
import { sendTelegramAlert } from "../lib/telegram";

const CHECK_INTERVAL_MS = 60_000;
const DEFAULT_COOLDOWN_MINUTES = 30;

let cooldownStartedAt: number | null = null;
let checkRunning = false;

function cooldownMinutes(): number {
  const configured = Number(process.env.PAPER_LOSS_COOLDOWN_MINUTES ?? DEFAULT_COOLDOWN_MINUTES);
  return Number.isFinite(configured) && configured >= 5
    ? Math.floor(configured)
    : DEFAULT_COOLDOWN_MINUTES;
}

function isConsecutiveLossHalt(reason: string | null | undefined): boolean {
  return /consecutive losses/i.test(reason ?? "");
}

async function notify(message: string): Promise<void> {
  try {
    await sendTelegramAlert(message);
  } catch (error) {
    console.error("[paper-auto-resume] Telegram notification failed:", error);
  }
}

async function checkAutoResume(): Promise<void> {
  if (checkRunning) return;
  checkRunning = true;

  try {
    const state = await loadState();

    if (!state.halted || !isConsecutiveLossHalt(state.haltReason)) {
      cooldownStartedAt = null;
      return;
    }

    if (cooldownStartedAt === null) {
      cooldownStartedAt = Date.now();
      const minutes = cooldownMinutes();
      console.log(`[paper-auto-resume] Consecutive-loss halt detected; cooldown ${minutes}m started.`);
      await notify(
        `⏸️ <b>[PAPER] Loss-streak cooldown active</b>\n\n` +
          `Reason: ${state.haltReason ?? "consecutive losses"}\n` +
          `Monitoring continues. Paper entries will resume automatically in about ${minutes} minutes.\n\n` +
          `Daily-loss safety halts still require manual review.`
      );
      return;
    }

    const elapsedMs = Date.now() - cooldownStartedAt;
    const requiredMs = cooldownMinutes() * 60_000;
    if (elapsedMs < requiredMs) return;

    state.halted = false;
    state.haltReason = null;
    state.consecutiveLosses = 0;
    await saveState(state);

    cooldownStartedAt = null;
    console.log("[paper-auto-resume] Paper trading automatically resumed after cooldown.");
    await notify(
      `✅ <b>[PAPER] Automatically resumed</b>\n\n` +
        `The consecutive-loss cooldown is complete.\n` +
        `Monitoring: ACTIVE\n` +
        `New paper entries: ENABLED\n` +
        `Bankroll: ${state.bankrollSol.toFixed(4)} SOL`
    );
  } catch (error) {
    console.error("[paper-auto-resume] Check failed:", error);
  } finally {
    checkRunning = false;
  }
}

export function startPaperAutoResumeScheduler(): void {
  const minutes = cooldownMinutes();
  console.log(
    `[paper-auto-resume] enabled; consecutive-loss halts cool down for ${minutes}m, daily-loss halts remain manual`
  );

  void checkAutoResume();
  setInterval(() => void checkAutoResume(), CHECK_INTERVAL_MS);
}
