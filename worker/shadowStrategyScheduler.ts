import { getSupabaseAdmin } from "../lib/supabase";
import {
  checkShadowPositions,
  getShadowSummary,
  onShadowAlert,
} from "../paper-trader/shadowStrategy";

const supabase = getSupabaseAdmin();
const ALERT_POLL_MS = 5_000;
const POSITION_CHECK_MS = 5_000;
const SUMMARY_INTERVAL_MS = 30 * 60_000;

let alertPollRunning = false;
let positionCheckRunning = false;

async function processNewAlerts(): Promise<void> {
  if (alertPollRunning) return;
  alertPollRunning = true;

  try {
    const { data: alerts, error: alertsError } = await supabase
      .from("alerts_sent")
      .select("id, token_mint, wallets_count, sent_at")
      .gte("sent_at", new Date(Date.now() - 2 * 60 * 60_000).toISOString())
      .order("sent_at", { ascending: true })
      .limit(50);

    if (alertsError) throw new Error(`shadow alert poll failed: ${alertsError.message}`);
    if (!alerts?.length) return;

    const alertIds = alerts.map((alert) => alert.id);
    const { data: processed, error: processedError } = await supabase
      .from("shadow_processed_alerts")
      .select("alert_id")
      .in("alert_id", alertIds);

    if (processedError) {
      throw new Error(`shadow processed-alert lookup failed: ${processedError.message}`);
    }

    const processedIds = new Set((processed ?? []).map((row) => row.alert_id));

    for (const alert of alerts) {
      if (processedIds.has(alert.id)) continue;

      try {
        const { data: score, error: scoreError } = await supabase
          .from("token_scores")
          .select(
            "token_symbol, score, total_sol_bought, market_cap, liquidity_usd"
          )
          .eq("token_mint", alert.token_mint)
          .single();

        if (scoreError || !score) {
          console.warn(
            `[shadow-strategy] no token score for ${alert.token_mint.slice(0, 6)}…`
          );
        } else {
          await onShadowAlert({
            tokenSymbol: score.token_symbol ?? "UNKNOWN",
            mint: alert.token_mint,
            score: Number(score.score),
            walletCount: Number(alert.wallets_count),
            totalBoughtSol: Number(score.total_sol_bought),
            marketCapUsd: Number(score.market_cap),
            liquidityUsd: Number(score.liquidity_usd),
          });
        }
      } catch (error) {
        console.error("[shadow-strategy] alert processing failed:", error);
      } finally {
        const { error: markError } = await supabase
          .from("shadow_processed_alerts")
          .upsert({
            alert_id: alert.id,
            processed_at: new Date().toISOString(),
          });

        if (markError) {
          console.error("[shadow-strategy] failed to mark alert processed:", markError);
        }
      }
    }
  } finally {
    alertPollRunning = false;
  }
}

async function checkPositionsSafely(): Promise<void> {
  if (positionCheckRunning) return;
  positionCheckRunning = true;
  try {
    await checkShadowPositions();
  } finally {
    positionCheckRunning = false;
  }
}

async function logSummary(): Promise<void> {
  const summary = await getShadowSummary();
  console.log(
    `[shadow-strategy] equity ${summary.equitySol.toFixed(3)} SOL | ` +
      `cash ${summary.bankrollSol.toFixed(3)} | open ${summary.openPositionValueSol.toFixed(3)} | ` +
      `trades ${summary.completedTrades} | PnL ${summary.totalPnlSol >= 0 ? "+" : ""}${summary.totalPnlSol.toFixed(3)}`
  );
}

export function startShadowStrategyScheduler(): void {
  console.log(
    "[shadow-strategy] enabled: independent 10 SOL bankroll; stricter strategy comparison"
  );

  void processNewAlerts().catch((error) =>
    console.error("[shadow-strategy] initial alert poll failed:", error)
  );
  void checkPositionsSafely().catch((error) =>
    console.error("[shadow-strategy] initial position check failed:", error)
  );
  void logSummary().catch((error) =>
    console.error("[shadow-strategy] initial summary failed:", error)
  );

  setInterval(() => {
    void processNewAlerts().catch((error) =>
      console.error("[shadow-strategy] alert poll failed:", error)
    );
  }, ALERT_POLL_MS);

  setInterval(() => {
    void checkPositionsSafely().catch((error) =>
      console.error("[shadow-strategy] position check failed:", error)
    );
  }, POSITION_CHECK_MS);

  setInterval(() => {
    void logSummary().catch((error) =>
      console.error("[shadow-strategy] summary failed:", error)
    );
  }, SUMMARY_INTERVAL_MS);
}
