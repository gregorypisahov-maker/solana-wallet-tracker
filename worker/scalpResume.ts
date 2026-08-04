import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import { startTelegramAlertRelay } from "./telegramAlertRelay";

startTelegramAlertRelay();

const supabase = getSupabaseAdmin();

export async function resumeScalper(): Promise<{ success: boolean; message: string; state?: Record<string, unknown> }> {
  try {
    const { data, error } = await supabase
      .from("scalp_state")
      .update({
        enabled: true,
        halted: false,
        halt_reason: null,
        consecutive_losses: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1)
      .select("*")
      .single();

    if (error) throw new Error(`Failed to resume scalper: ${error.message}`);

    const message = "✅ Helius sniper RESUMED and ready to scan";
    console.log(`[scalp-resume] ${message}`);
    await sendTelegramAlert(`${message}\n\nThe consecutive-loss halt was cleared and new paper entries are enabled.`);

    return { success: true, message, state: data };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[scalp-resume] Error:", errorMsg);
    await sendTelegramAlert(`❌ Failed to resume Helius sniper: ${errorMsg}`).catch(() => {});
    return { success: false, message: `Resume failed: ${errorMsg}` };
  }
}

export async function pauseScalper(reason: string = "manual_pause"): Promise<{ success: boolean; message: string; state?: Record<string, unknown> }> {
  try {
    const { data, error } = await supabase
      .from("scalp_state")
      .update({ halted: true, halt_reason: reason, updated_at: new Date().toISOString() })
      .eq("id", 1)
      .select("*")
      .single();

    if (error) throw new Error(`Failed to pause scalper: ${error.message}`);

    const message = `⏸️ Momentum scalper PAUSED (reason: ${reason})`;
    console.log(`[scalp-pause] ${message}`);
    await sendTelegramAlert(message).catch(() => {});

    return { success: true, message, state: data };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[scalp-pause] Error:", errorMsg);
    return { success: false, message: `Pause failed: ${errorMsg}` };
  }
}

export async function getScalperStatus(): Promise<{ enabled: boolean; halted: boolean; halt_reason: string | null; bankroll_sol: number; entries_today: number; consecutive_losses: number }> {
  const { data, error } = await supabase
    .from("scalp_state")
    .select("enabled, halted, halt_reason, bankroll_sol, entries_today, consecutive_losses")
    .eq("id", 1)
    .single();

  if (error || !data) throw error;
  return { enabled: data.enabled as boolean, halted: data.halted as boolean, halt_reason: data.halt_reason as string | null, bankroll_sol: Number(data.bankroll_sol || 0), entries_today: data.entries_today as number, consecutive_losses: data.consecutive_losses as number };
}
