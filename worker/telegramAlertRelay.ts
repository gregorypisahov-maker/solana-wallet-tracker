import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";

function cleanEnv(value: string | undefined): string {
  return (value ?? "").trim().replace(/^[\'\"]|[\'\"]$/g, "").trim();
}

const TELEGRAM_BOT_TOKEN = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
const TELEGRAM_CHAT_ID = cleanEnv(process.env.TELEGRAM_CHAT_ID);
const POLL_MS = Math.max(2_000, Number(process.env.TELEGRAM_ALERT_RELAY_POLL_MS) || 5_000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.TELEGRAM_ALERT_RELAY_MAX_ATTEMPTS) || 5);
const STALE_SENDING_MS = Math.max(
  60_000,
  Number(process.env.TELEGRAM_ALERT_RELAY_STALE_SENDING_MS) || 5 * 60_000,
);
const supabase = getSupabaseAdmin();
let relayRunning = false;
let relayStarted = false;

interface AlertRow {
  id: number;
  message: string;
  attempts: number;
}

async function sendMessage(message: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

async function recoverStaleClaims(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
  const { error } = await supabase
    .from("telegram_alert_outbox")
    .update({
      status: "failed",
      claimed_at: null,
      last_error: "Relay claim expired before completion; queued for retry.",
    })
    .eq("status", "sending")
    .lt("claimed_at", cutoff);
  if (error) throw new Error(error.message);
}

async function processOutbox(): Promise<void> {
  if (relayRunning || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  relayRunning = true;
  try {
    await recoverStaleClaims();

    const { data, error } = await supabase
      .from("telegram_alert_outbox")
      .select("id,message,attempts")
      .in("status", ["pending", "failed"])
      .lt("attempts", MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(10);
    if (error) throw new Error(error.message);

    for (const candidate of (data ?? []) as AlertRow[]) {
      const now = new Date().toISOString();
      const { data: claimed, error: claimError } = await supabase
        .from("telegram_alert_outbox")
        .update({ status: "sending", claimed_at: now })
        .eq("id", candidate.id)
        .in("status", ["pending", "failed"])
        .select("id,message,attempts")
        .maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (!claimed) continue;

      try {
        await sendMessage(String(claimed.message));
        const { error: sentError } = await supabase
          .from("telegram_alert_outbox")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            claimed_at: null,
            last_error: null,
          })
          .eq("id", claimed.id);
        if (sentError) throw new Error(sentError.message);
        console.log(`[telegram-alert-relay] delivered alert ${claimed.id}`);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        await supabase
          .from("telegram_alert_outbox")
          .update({
            status: "failed",
            claimed_at: null,
            attempts: Number(claimed.attempts ?? 0) + 1,
            last_error: reason.slice(0, 1_000),
          })
          .eq("id", claimed.id);
        console.error(`[telegram-alert-relay] alert ${claimed.id} failed:`, reason);
      }
    }
  } catch (error) {
    console.error("[telegram-alert-relay] poll failed:", error);
  } finally {
    relayRunning = false;
  }
}

export function startTelegramAlertRelay(): void {
  if (relayStarted) return;
  relayStarted = true;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("[telegram-alert-relay] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required. Relay disabled.");
    return;
  }
  console.log(
    `[telegram-alert-relay] started; pollMs=${POLL_MS} staleSendingMs=${STALE_SENDING_MS}`,
  );
  void processOutbox();
  setInterval(() => void processOutbox(), POLL_MS);
}
