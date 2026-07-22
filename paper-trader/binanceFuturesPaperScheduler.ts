import { getSupabaseAdmin } from "../lib/supabase";
import { ensureNodeWebSocket } from "../lib/nodeWebSocket";
import {
  BINANCE_FUTURES_PAPER_CONFIG,
  startBinanceFuturesPaperScheduler as startEngine,
} from "./binanceFuturesPaper";

const RESET_INTERVAL_MS = 60_000;
let started = false;

async function resetDailyStateIfNeeded(): Promise<void> {
  const supabase = getSupabaseAdmin({ noStore: true });
  const todayUtc = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("binance_futures_state")
    .select("daily_date")
    .eq("id", 1)
    .single();

  if (error) {
    console.error("[binance-futures-paper] daily reset read failed:", error.message);
    return;
  }
  if (String(data.daily_date) === todayUtc) return;

  const { error: updateError } = await supabase
    .from("binance_futures_state")
    .update({
      daily_date: todayUtc,
      daily_realized_pnl_usdt: 0,
      entries_today: 0,
      consecutive_losses: 0,
      halted: false,
      halt_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (updateError) {
    console.error("[binance-futures-paper] daily reset failed:", updateError.message);
  } else {
    console.log(`[binance-futures-paper] UTC daily risk counters reset for ${todayUtc}`);
  }
}

export function startBinanceFuturesPaperBot(): void {
  if (started) return;
  started = true;
  if (!BINANCE_FUTURES_PAPER_CONFIG.enabled) {
    console.log("[binance-futures-paper] disabled by configuration");
    return;
  }

  ensureNodeWebSocket();
  void resetDailyStateIfNeeded();
  setInterval(() => void resetDailyStateIfNeeded(), RESET_INTERVAL_MS);
  startEngine();
}
