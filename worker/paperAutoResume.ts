// worker/paperAutoResume.ts
// Auto-resume paper trader if it halts (recovers from daily loss limits)

import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

const supabase = getSupabaseAdmin();

const AUTO_RESUME_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 min

export function startPaperAutoResumeScheduler(): void {
  setInterval(async () => {
    try {
      await checkAndAutoResume();
    } catch (error) {
      console.error("[paper-auto-resume] Check failed:", error);
    }
  }, AUTO_RESUME_CHECK_INTERVAL_MS);

  console.log(
    `[paper-auto-resume] Scheduler started; checking every ${AUTO_RESUME_CHECK_INTERVAL_MS / 1000}s`
  );
}

async function checkAndAutoResume(): Promise<void> {
  // Check BOTH paper trader and scalper
  await tryAutoResumePaperTrader();
  await tryAutoResumeScalper();
}

async function tryAutoResumePaperTrader(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("paper_state")
      .select("halted, halt_reason, daily_date")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      console.warn("[paper-auto-resume] Failed to load paper state:", error);
      return;
    }

    if (!data || !data.halted) return;

    const today = new Date().toISOString().slice(0, 10);
    if (data.daily_date !== today) {
      // New day = auto-resume
      const { error: updateError } = await supabase
        .from("paper_state")
        .update({
          halted: false,
          halt_reason: null,
          daily_date: today,
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1);

      if (updateError) {
        console.error(
          "[paper-auto-resume] Failed to resume paper trader:",
          updateError
        );
        return;
      }

      console.log(
        `[paper-auto-resume] Paper trader auto-resumed for new day (was: ${data.halt_reason})`
      );

      await sendTelegramAlert(
        "🟢 <b>Paper trader auto-resumed</b> for new trading day (daily loss limit reset)"
      ).catch(() => {});
    }
  } catch (error) {
    console.error("[paper-auto-resume] Unexpected error checking paper trader:", error);
  }
}

async function tryAutoResumeScalper(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("scalp_state")
      .select("halted, halt_reason, daily_date")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      console.warn("[paper-auto-resume] Failed to load scalp state:", error);
      return;
    }

    if (!data || !data.halted) return;

    const today = new Date().toISOString().slice(0, 10);
    if (data.daily_date !== today) {
      // New day = auto-resume
      const { error: updateError } = await supabase
        .from("scalp_state")
        .update({
          halted: false,
          halt_reason: null,
          daily_date: today,
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1);

      if (updateError) {
        console.error(
          "[paper-auto-resume] Failed to resume scalper:",
          updateError
        );
        return;
      }

      console.log(
        `[paper-auto-resume] Scalper auto-resumed for new day (was: ${data.halt_reason})`
      );

      await sendTelegramAlert(
        "⚡ <b>Scalper auto-resumed</b> for new trading day (daily entry limit & loss limits reset)"
      ).catch(() => {});
    }
  } catch (error) {
    console.error("[paper-auto-resume] Unexpected error checking scalper:", error);
  }
}
