import "dotenv/config";

import { getSupabaseAdmin } from "../lib/supabase";
import {
  checkShadowPositions,
  getShadowSummary,
  onShadowAlert,
} from "../paper-trader/shadowStrategy";
import { computeWeightedWalletScore } from "../paper-trader/trustScore";
import { getTrustScoresForWallets } from "../paper-trader/walletPerformance";
import { evaluateShadowCopierWalletQuality } from "../paper-trader/shadowCopierWalletQuality";
import { loadShadowCoinQuality } from "../paper-trader/shadowCoinQuality";
import type { AlertInput } from "../paper-trader/types";

const supabase = getSupabaseAdmin();
const STRATEGY_VERSION = "shadow_copier_quality_v2_2026_07_22";

function boundedInterval(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

const ALERT_POLL_MS = boundedInterval(process.env.SHADOW_ALERT_POLL_MS, 10_000, 5_000, 60_000);
const POSITION_CHECK_MS = boundedInterval(process.env.SHADOW_POSITION_CHECK_MS, 6_000, 3_000, 60_000);
const SUMMARY_INTERVAL_MS = 30 * 60_000;

const SHADOW_FILTERS = {
  minScore: 10,
  maxScore: 65,
  minWallets: 3,
  minAvgBuySol: 0.75,
  minAverageTrustScore: 55,
  eliteTwoWalletMinAvgBuySol: 1.25,
  eliteTwoWalletMinAvgTrustScore: 60,
  minLiquidityUsd: 15_000,
  minLiquidityToMarketCapRatio: 0.15,
  minMarketCapUsd: 20_000,
  maxMarketCapUsd: 200_000,
};

type Participant = { wallet_address: string; sol_amount: number | string };
type DecisionSnapshot = Record<string, unknown> & {
  strategy_version: string;
  score: number | null;
  marketCapUsd: number | null;
  averageTrustScore: number | null;
  liquidityUsd: number | null;
  liqRatio: number | null;
  walletCount: number | null;
  totalBoughtSol: number | null;
  avgBuySol: number | null;
};

let alertPollRunning = false;
let positionCheckRunning = false;

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function basicFilterEvaluation(input: {
  score: unknown;
  marketCapUsd: unknown;
  averageTrustScore: unknown;
  liquidityUsd: unknown;
  walletCount: unknown;
  totalBoughtSol: unknown;
}): { skipReasons: string[]; snapshot: DecisionSnapshot } {
  const score = finiteNumber(input.score);
  const marketCapUsd = finiteNumber(input.marketCapUsd);
  const averageTrustScore = finiteNumber(input.averageTrustScore);
  const liquidityUsd = finiteNumber(input.liquidityUsd);
  const walletCount = finiteNumber(input.walletCount);
  const totalBoughtSol = finiteNumber(input.totalBoughtSol);
  const avgBuySol =
    walletCount !== null && walletCount > 0 && totalBoughtSol !== null
      ? totalBoughtSol / walletCount
      : null;
  const liqRatio =
    marketCapUsd !== null && marketCapUsd > 0 && liquidityUsd !== null
      ? liquidityUsd / marketCapUsd
      : null;
  const skipReasons: string[] = [];

  if (score === null) skipReasons.push("missing_score_data");
  else {
    if (score < SHADOW_FILTERS.minScore) skipReasons.push("score_below_10");
    if (score > SHADOW_FILTERS.maxScore) skipReasons.push("score_above_65");
  }

  if (walletCount === null || walletCount <= 0) skipReasons.push("missing_wallet_count");
  if (totalBoughtSol === null || totalBoughtSol <= 0) skipReasons.push("missing_total_bought_sol");
  if (avgBuySol === null) skipReasons.push("missing_avg_buy_sol");
  else if (avgBuySol < SHADOW_FILTERS.minAvgBuySol) skipReasons.push("avg_buy_below_0_75");

  if (averageTrustScore === null) skipReasons.push("missing_trust_data");
  else {
    if (averageTrustScore < SHADOW_FILTERS.minAverageTrustScore) skipReasons.push("trust_below_55");
    const eliteTwoWallet =
      walletCount === 2 &&
      avgBuySol !== null &&
      avgBuySol >= SHADOW_FILTERS.eliteTwoWalletMinAvgBuySol &&
      averageTrustScore >= SHADOW_FILTERS.eliteTwoWalletMinAvgTrustScore;
    if (walletCount !== null && walletCount < SHADOW_FILTERS.minWallets && !eliteTwoWallet) {
      skipReasons.push(walletCount === 2 ? "two_wallet_elite_gate_failed" : "wallet_count_below_3");
    }
  }

  if (marketCapUsd === null) skipReasons.push("missing_market_cap_data");
  else {
    if (marketCapUsd < SHADOW_FILTERS.minMarketCapUsd) skipReasons.push("mcap_below_20k");
    if (marketCapUsd > SHADOW_FILTERS.maxMarketCapUsd) skipReasons.push("mcap_above_200k");
  }

  if (liquidityUsd === null) skipReasons.push("missing_liquidity_data");
  else if (liquidityUsd < SHADOW_FILTERS.minLiquidityUsd) skipReasons.push("liquidity_below_15k");
  if (marketCapUsd !== null && marketCapUsd <= 0) {
    skipReasons.push("invalid_market_cap_for_liq_ratio");
  } else if (liqRatio !== null && liqRatio < SHADOW_FILTERS.minLiquidityToMarketCapRatio) {
    skipReasons.push("liq_ratio_below_15pct");
  }

  return {
    skipReasons,
    snapshot: {
      strategy_version: STRATEGY_VERSION,
      score,
      marketCapUsd,
      averageTrustScore,
      liquidityUsd,
      liqRatio,
      walletCount,
      totalBoughtSol,
      avgBuySol,
    },
  };
}

async function loadParticipants(tokenMint: string, alertSentAt: string): Promise<Participant[]> {
  const { data, error } = await supabase
    .from("alert_participants")
    .select("wallet_address,sol_amount")
    .eq("token_mint", tokenMint)
    .eq("alert_sent_at", alertSentAt);
  if (error) throw new Error(`shadow participant lookup failed: ${error.message}`);
  const byWallet = new Map<string, number>();
  for (const row of data ?? []) {
    const address = String(row.wallet_address ?? "");
    if (!address) continue;
    byWallet.set(address, (byWallet.get(address) ?? 0) + Number(row.sol_amount ?? 0));
  }
  return [...byWallet.entries()].map(([wallet_address, sol_amount]) => ({ wallet_address, sol_amount }));
}

async function loadAverageTrustScore(
  addresses: string[]
): Promise<{ average: number | null; missing: string[] }> {
  if (!addresses.length) return { average: null, missing: [] };
  const trustScoreMap = await getTrustScoresForWallets(addresses);
  const missing = addresses.filter((address) => !trustScoreMap.has(address));
  if (missing.length > 0) return { average: null, missing };
  const weighted = computeWeightedWalletScore(
    addresses.map((address) => ({
      address,
      trustScore: trustScoreMap.get(address) as number,
    }))
  );
  return { average: finiteNumber(weighted.averageTrustScore), missing };
}

async function processNewAlerts(): Promise<void> {
  if (alertPollRunning) return;
  alertPollRunning = true;

  try {
    const { data: alerts, error: alertsError } = await supabase
      .from("alerts_sent")
      .select("id,token_mint,wallets_count,sent_at")
      .gte("sent_at", new Date(Date.now() - 2 * 60 * 60_000).toISOString())
      .order("sent_at", { ascending: true })
      .limit(50);
    if (alertsError) throw new Error(`shadow alert poll failed: ${alertsError.message}`);
    if (!alerts?.length) return;

    const alertIds = alerts.map((alert: any) => alert.id);
    const { data: processed, error: processedError } = await supabase
      .from("shadow_processed_alerts")
      .select("alert_id")
      .in("alert_id", alertIds);
    if (processedError) {
      throw new Error(`shadow processed-alert lookup failed: ${processedError.message}`);
    }
    const processedIds = new Set((processed ?? []).map((row: any) => row.alert_id));

    for (const alert of alerts as any[]) {
      if (processedIds.has(alert.id)) continue;
      let entered = false;
      let skipReasons: string[] = [];
      let signalMultiplier: number | null = null;
      let snapshot: DecisionSnapshot = {
        strategy_version: STRATEGY_VERSION,
        score: null,
        marketCapUsd: null,
        averageTrustScore: null,
        liquidityUsd: null,
        liqRatio: null,
        walletCount: null,
        totalBoughtSol: null,
        avgBuySol: null,
      };

      try {
        const [{ data: score, error: scoreError }, participants] = await Promise.all([
          supabase
            .from("token_scores")
            .select("token_symbol,score,total_sol_bought,market_cap,liquidity_usd")
            .eq("token_mint", alert.token_mint)
            .single(),
          loadParticipants(alert.token_mint, alert.sent_at),
        ]);

        snapshot.participants = participants;
        if (scoreError || !score) skipReasons.push("missing_token_score_row");
        if (!participants.length) skipReasons.push("missing_alert_participants");

        const addresses = participants.map((row) => row.wallet_address);
        const trust = await loadAverageTrustScore(addresses);
        if (trust.missing.length > 0) {
          snapshot.missing_trust_wallets = trust.missing;
          skipReasons.push("missing_wallet_trust_rows");
        }
        if (score) {
          const basic = basicFilterEvaluation({
            score: score.score,
            marketCapUsd: score.market_cap,
            averageTrustScore: trust.average,
            liquidityUsd: score.liquidity_usd,
            walletCount: alert.wallets_count,
            totalBoughtSol: score.total_sol_bought,
          });
          snapshot = { ...snapshot, ...basic.snapshot, participants };
          skipReasons.push(...basic.skipReasons);
        }

        if (skipReasons.length === 0) {
          try {
            const copierQuality = await evaluateShadowCopierWalletQuality(participants);
            snapshot.wallet_quality = copierQuality.snapshot;
            signalMultiplier = copierQuality.signalMultiplier;
            if (!copierQuality.pass) skipReasons.push(...copierQuality.reasons);
            if (copierQuality.pass && signalMultiplier == null) {
              skipReasons.push("copier_signal_multiplier_unresolved");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            snapshot.wallet_quality = {
              data_source: "tiered_copier_returns",
              status: "unresolved",
              error: message,
            };
            skipReasons.push("copier_wallet_quality_unresolved");
          }
        } else {
          snapshot.wallet_quality = { status: "not_evaluated_due_to_basic_filter_rejection" };
        }

        if (skipReasons.length === 0) {
          const coinQuality = await loadShadowCoinQuality(alert.token_mint);
          snapshot.coin_quality = {
            resolved: coinQuality.resolved,
            pass: coinQuality.pass,
            creator_wallet: coinQuality.creatorWallet,
            creation_block: coinQuality.creationBlock,
            same_block_buyer_count: coinQuality.sameBlockBuyerCount,
            first_five_block_buyer_count: coinQuality.firstFiveBlockBuyerCount,
            bundle_detected: coinQuality.bundleDetected,
            sniper_detected: coinQuality.sniperDetected,
            reasons: coinQuality.reasons,
            fetched_at: coinQuality.fetchedAt,
            error: coinQuality.error,
          };
          if (!coinQuality.resolved) skipReasons.push("coin_quality_unresolved");
          else if (!coinQuality.pass) skipReasons.push(...coinQuality.reasons);
        } else {
          snapshot.coin_quality = { status: "not_evaluated_due_to_prior_rejection" };
        }

        if (skipReasons.length === 0 && score && signalMultiplier != null) {
          const alertInput: AlertInput = {
            tokenSymbol: score.token_symbol ?? "UNKNOWN",
            mint: alert.token_mint,
            score: Number(snapshot.score),
            walletCount: Number(alert.wallets_count),
            totalBoughtSol: Number(score.total_sol_bought),
            marketCapUsd: Number(snapshot.marketCapUsd),
            liquidityUsd: Number(snapshot.liquidityUsd),
            averageTrustScore: Number(snapshot.averageTrustScore),
            strategyVersion: STRATEGY_VERSION,
            shadowSizeMultiplier: signalMultiplier,
            shadowStudyDecision: snapshot,
          };

          await onShadowAlert(alertInput);
          const { data: openedPosition, error: positionError } = await supabase
            .from("shadow_positions")
            .select("mint")
            .eq("mint", alert.token_mint)
            .maybeSingle();
          if (positionError) {
            throw new Error(`shadow position verification failed: ${positionError.message}`);
          }
          entered = Boolean(openedPosition);
          if (!entered) skipReasons.push("strategy_did_not_open_position");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[shadow-study] alert processing failed:", error);
        snapshot.processing_error = message;
        if (!skipReasons.length) skipReasons.push("processing_error");
      } finally {
        if (!entered && !skipReasons.length) skipReasons.push("not_entered");
        snapshot.final_decision = entered ? "entered" : "rejected";
        snapshot.final_reasons = skipReasons;
        console.log(
          `[shadow-study] ${alert.token_mint.slice(0, 6)} decision=${entered ? "entered" : "rejected"} ` +
            `reasons=${skipReasons.length ? skipReasons.join("|") : "none"}`
        );
        const { error: markError } = await supabase.from("shadow_processed_alerts").upsert({
          alert_id: alert.id,
          processed_at: new Date().toISOString(),
          entered,
          skip_reasons: entered ? null : skipReasons,
          filter_snapshot: snapshot,
        });
        if (markError) console.error("[shadow-study] failed to mark alert processed:", markError);
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
    `[shadow-study] equity ${summary.equitySol.toFixed(3)} SOL | ` +
      `cash ${summary.bankrollSol.toFixed(3)} | open ${summary.openPositionValueSol.toFixed(3)} | ` +
      `trades ${summary.completedTrades} | PnL ${summary.totalPnlSol >= 0 ? "+" : ""}${summary.totalPnlSol.toFixed(3)}`
  );
}

export function startShadowStrategyScheduler(): void {
  console.log(
    `[shadow-study] ${STRATEGY_VERSION} active; copier t<0 and decay rejected, ` +
      `confidence-weighted sizing with 0.15x probes, same-block bundle rejection; ` +
      `alerts ${ALERT_POLL_MS / 1000}s, positions ${POSITION_CHECK_MS / 1000}s`
  );
  void processNewAlerts().catch((error) =>
    console.error("[shadow-study] initial alert poll failed:", error)
  );
  void checkPositionsSafely().catch((error) =>
    console.error("[shadow-study] initial position check failed:", error)
  );
  void logSummary().catch((error) =>
    console.error("[shadow-study] initial summary failed:", error)
  );

  setInterval(
    () => void processNewAlerts().catch((error) => console.error("[shadow-study] alert poll failed:", error)),
    ALERT_POLL_MS
  );
  setInterval(
    () => void checkPositionsSafely().catch((error) => console.error("[shadow-study] position check failed:", error)),
    POSITION_CHECK_MS
  );
  setInterval(
    () => void logSummary().catch((error) => console.error("[shadow-study] summary failed:", error)),
    SUMMARY_INTERVAL_MS
  );
}
