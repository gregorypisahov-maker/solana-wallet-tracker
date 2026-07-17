import { getSupabaseAdmin } from "../lib/supabase";
import {
  checkShadowPositions,
  getShadowSummary,
  onShadowAlert,
} from "../paper-trader/shadowStrategy";
import { computeWeightedWalletScore } from "../paper-trader/trustScore";
import { getTrustScoresForWallets } from "../paper-trader/walletPerformance";

const supabase = getSupabaseAdmin();
const ALERT_POLL_MS = 5_000;
const POSITION_CHECK_MS = 5_000;
const SUMMARY_INTERVAL_MS = 30 * 60_000;

const SHADOW_FILTERS = {
  maxMarketCapUsd: 200_000,
  maxScore: 65,
  minAverageTrustScore: 55,
  minLiquidityToMarketCapRatio: 0.15,
};

type FilterSnapshot = {
  score: number | null;
  marketCapUsd: number | null;
  averageTrustScore: number | null;
  liquidityUsd: number | null;
  liqRatio: number | null;
};

type FilterEvaluation = {
  skipReasons: string[];
  snapshot: FilterSnapshot;
};

let alertPollRunning = false;
let positionCheckRunning = false;

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function evaluateRequiredFilters(input: {
  score: unknown;
  marketCapUsd: unknown;
  averageTrustScore: unknown;
  liquidityUsd: unknown;
}): FilterEvaluation {
  const score = finiteNumber(input.score);
  const marketCapUsd = finiteNumber(input.marketCapUsd);
  const averageTrustScore = finiteNumber(input.averageTrustScore);
  const liquidityUsd = finiteNumber(input.liquidityUsd);
  const liqRatio =
    marketCapUsd !== null && marketCapUsd > 0 && liquidityUsd !== null
      ? liquidityUsd / marketCapUsd
      : null;

  const skipReasons: string[] = [];

  if (score === null) skipReasons.push("missing_score_data");
  else if (score > SHADOW_FILTERS.maxScore) skipReasons.push("score_above_65");

  if (marketCapUsd === null) skipReasons.push("missing_market_cap_data");
  else if (marketCapUsd > SHADOW_FILTERS.maxMarketCapUsd) {
    skipReasons.push("mcap_above_200k");
  }

  if (averageTrustScore === null) skipReasons.push("missing_trust_data");
  else if (averageTrustScore < SHADOW_FILTERS.minAverageTrustScore) {
    skipReasons.push("trust_below_55");
  }

  if (liquidityUsd === null) skipReasons.push("missing_liquidity_data");
  if (marketCapUsd !== null && marketCapUsd <= 0) {
    skipReasons.push("invalid_market_cap_for_liq_ratio");
  } else if (liqRatio !== null && liqRatio < SHADOW_FILTERS.minLiquidityToMarketCapRatio) {
    skipReasons.push("liq_ratio_below_15pct");
  }

  return {
    skipReasons,
    snapshot: {
      score,
      marketCapUsd,
      averageTrustScore,
      liquidityUsd,
      liqRatio,
    },
  };
}

async function loadAverageTrustScore(
  tokenMint: string,
  alertSentAt: string
): Promise<number | null> {
  const { data: participants, error: participantsError } = await supabase
    .from("alert_participants")
    .select("wallet_address")
    .eq("token_mint", tokenMint)
    .eq("alert_sent_at", alertSentAt);

  if (participantsError) {
    throw new Error(`shadow participant lookup failed: ${participantsError.message}`);
  }

  const addresses = Array.from(
    new Set((participants ?? []).map((row) => row.wallet_address).filter(Boolean))
  );
  if (!addresses.length) return null;

  const trustScoreMap = await getTrustScoresForWallets(addresses);
  const weighted = computeWeightedWalletScore(
    addresses.map((address) => ({
      address,
      trustScore: trustScoreMap.get(address) ?? 50,
    }))
  );

  return finiteNumber(weighted.averageTrustScore);
}

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

      let entered = false;
      let skipReasons: string[] = [];
      let filterSnapshot: FilterSnapshot = {
        score: null,
        marketCapUsd: null,
        averageTrustScore: null,
        liquidityUsd: null,
        liqRatio: null,
      };

      try {
        const { data: score, error: scoreError } = await supabase
          .from("token_scores")
          .select("token_symbol, score, total_sol_bought, market_cap, liquidity_usd")
          .eq("token_mint", alert.token_mint)
          .single();

        if (scoreError || !score) {
          skipReasons = ["missing_token_score_row"];
          console.warn(
            `[shadow-strategy] no token score for ${alert.token_mint.slice(0, 6)}…`
          );
        } else {
          const averageTrustScore = await loadAverageTrustScore(
            alert.token_mint,
            alert.sent_at
          );
          const evaluation = evaluateRequiredFilters({
            score: score.score,
            marketCapUsd: score.market_cap,
            averageTrustScore,
            liquidityUsd: score.liquidity_usd,
          });
          skipReasons = evaluation.skipReasons;
          filterSnapshot = evaluation.snapshot;

          if (skipReasons.length === 0) {
            const numericScore = filterSnapshot.score as number;
            const numericMarketCap = filterSnapshot.marketCapUsd as number;
            const numericLiquidity = filterSnapshot.liquidityUsd as number;
            const numericTrust = filterSnapshot.averageTrustScore as number;

            await onShadowAlert({
              tokenSymbol: score.token_symbol ?? "UNKNOWN",
              mint: alert.token_mint,
              score: numericScore,
              walletCount: Number(alert.wallets_count),
              totalBoughtSol: Number(score.total_sol_bought),
              marketCapUsd: numericMarketCap,
              liquidityUsd: numericLiquidity,
              averageTrustScore: numericTrust,
            });

            const { data: openedPosition, error: positionError } = await supabase
              .from("shadow_positions")
              .select("mint")
              .eq("mint", alert.token_mint)
              .maybeSingle();
            if (positionError) {
              throw new Error(`shadow position verification failed: ${positionError.message}`);
            }

            entered = Boolean(openedPosition);
            if (!entered) skipReasons = ["strategy_did_not_open_position"];
          } else {
            console.log(
              `[SHADOW REJECT] ${score.token_symbol ?? "UNKNOWN"}: ${skipReasons.join(", ")}`
            );
          }
        }
      } catch (error) {
        console.error("[shadow-strategy] alert processing failed:", error);
        if (!skipReasons.length) skipReasons = ["processing_error"];
      } finally {
        if (!entered && !skipReasons.length) skipReasons = ["not_entered"];

        const { error: markError } = await supabase
          .from("shadow_processed_alerts")
          .upsert({
            alert_id: alert.id,
            processed_at: new Date().toISOString(),
            entered,
            skip_reasons: entered ? null : skipReasons,
            filter_snapshot: filterSnapshot,
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
