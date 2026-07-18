import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

const supabase = getSupabaseAdmin();
const AUTO_RESUME_CHECK_INTERVAL_MS = 5 * 60 * 1000;

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
  await tryAutoResumePaperTrader();
  await tryAutoResumeScalper();
}

async function tryAutoResumePaperTrader(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("paper_state")
      .select(
        "halted, halt_reason, daily_reset_date, bankroll_sol, daily_start_bankroll_sol"
      )
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      console.warn("[paper-auto-resume] Failed to load paper state:", error);
      return;
    }
    if (!data) return;

    // paper_state stores the same Date.toDateString() format used by the
    // regular paper-trading engine. The old scheduler queried a non-existent
    // daily_date column, creating repeated Postgres errors every five minutes.
    const today = new Date().toDateString();
    if (data.daily_reset_date !== today) {
      const bankrollSol = Number(data.bankroll_sol ?? 0);
      const { error: updateError } = await supabase
        .from("paper_state")
        .update({
          halted: false,
          halt_reason: null,
          daily_reset_date: today,
          daily_start_bankroll_sol: Number.isFinite(bankrollSol)
            ? bankrollSol
            : Number(data.daily_start_bankroll_sol ?? 0),
          consecutive_losses: 0,
        })
        .eq("id", 1);

      if (updateError) {
        console.error(
          "[paper-auto-resume] Failed to reset paper trader for new day:",
          updateError
        );
        return;
      }

      console.log(
        `[paper-auto-resume] Paper trader reset for new day (was: ${data.halt_reason ?? "not halted"})`
      );
      if (data.halted) {
        await sendTelegramAlert(
          "🟢 <b>Paper trader auto-resumed</b> for the new trading day (daily risk counters reset)"
        ).catch(() => {});
      }
    }
  } catch (error) {
    console.error(
      "[paper-auto-resume] Unexpected error checking paper trader:",
      error
    );
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
    if (!data) return;

    const today = new Date().toISOString().slice(0, 10);
    if (data.daily_date !== today) {
      const { error: updateError } = await supabase
        .from("scalp_state")
        .update({
          halted: false,
          halt_reason: null,
          daily_date: today,
          entries_today: 0,
          daily_realized_pnl_sol: 0,
          consecutive_losses: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1);

      if (updateError) {
        console.error(
          "[paper-auto-resume] Failed to reset scalper for new day:",
          updateError
        );
        return;
      }

      console.log(
        `[paper-auto-resume] Scalper reset for new day (was: ${data.halt_reason ?? "not halted"})`
      );
      if (data.halted) {
        await sendTelegramAlert(
          "⚡ <b>Scalper auto-resumed</b> for the new trading day (daily entry and loss counters reset)"
        ).catch(() => {});
      }
    }
  } catch (error) {
    console.error(
      "[paper-auto-resume] Unexpected error checking scalper:",
      error
    );
  }
}
