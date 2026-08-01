import { getSupabaseAdmin } from "../lib/supabase";

const BOOTSTRAP_WATCHDOG_MS = 25_000;

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeBootstrapError(message: string): Promise<void> {
  try {
    const supabase = getSupabaseAdmin({ noStore: true });
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("sol_spot_paper_state")
      .update({
        connection_status: "error",
        last_error: message.slice(0, 500),
        last_heartbeat_at: now,
        updated_at: now,
      })
      .eq("id", 1);
    if (error) console.error("[sol-spot-bootstrap] state update failed", error.message);
  } catch (error) {
    console.error("[sol-spot-bootstrap] could not write bootstrap error", compactError(error));
  }
}

async function verifyHeartbeat(): Promise<void> {
  try {
    const supabase = getSupabaseAdmin({ noStore: true });
    const { data, error } = await supabase
      .from("sol_spot_paper_state")
      .select("last_heartbeat_at,connection_status,last_error")
      .eq("id", 1)
      .single();
    if (error) throw new Error(error.message);
    const heartbeatMs = data?.last_heartbeat_at ? Date.parse(data.last_heartbeat_at) : 0;
    const fresh = heartbeatMs > 0 && Date.now() - heartbeatMs < 90_000;
    if (!fresh) {
      await writeBootstrapError(
        data?.last_error ||
          "SOL spot worker loaded but produced no heartbeat. Check the Railway worker logs and Binance market-data access."
      );
    }
  } catch (error) {
    console.error("[sol-spot-bootstrap] heartbeat verification failed", compactError(error));
  }
}

export async function startSolSpotPaperBootstrap(): Promise<void> {
  process.env.BINANCE_SPOT_REST_URL =
    process.env.BINANCE_SPOT_REST_URL?.trim() || "https://data-api.binance.vision";

  try {
    const { startSolSpotPaperBot } = await import("./solSpotPaper");
    startSolSpotPaperBot();
    console.log(
      `[sol-spot-bootstrap] module loaded with marketData=${process.env.BINANCE_SPOT_REST_URL}`
    );
    setTimeout(() => void verifyHeartbeat(), BOOTSTRAP_WATCHDOG_MS);
  } catch (error) {
    const message = `SOL spot module failed to load: ${compactError(error)}`;
    console.error("[sol-spot-bootstrap]", message);
    await writeBootstrapError(message);
  }
}
