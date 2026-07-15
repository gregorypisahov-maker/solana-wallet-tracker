import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Logs, PublicKey } from "@solana/web3.js";
import {
  getConnection,
  fetchNewSignatures,
  getParsedTx,
  extractTrade,
} from "../lib/solana";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { computeScore } from "../lib/scoring";
import {
  sendTelegramAlert,
  formatConsensusAlert,
} from "../lib/telegram";
import {
  onAlert,
  checkPositions,
} from "../paper-trader/engine";
import {
  sendDailyPaperReportIfDue,
} from "../paper-trader/statsReporter";
import {
  getTrustScoresForWallets,
  computeAndStoreWalletPerformance,
} from "../paper-trader/walletPerformance";
import {
  computeWeightedWalletScore,
} from "../paper-trader/trustScore";
import {
  getRateLimitDelayMs,
  isFreshTimestamp,
  readBoundedNumber,
  RpcPacer,
} from "./monitorSafety";
import {
  SerialEventQueue,
  SignatureDeduper,
  signatureEventKey,
  WalletSignatureEvent,
} from "./eventIntake";
import {
  estimateHeliusCredits,
  HeliusUsageTracker,
} from "./heliusUsage";
import { ensureHeliusSwapWebhook } from "./heliusWebhookManager";
import { selectHeliusWallets } from "./heliusWalletSelection";

const RECONCILE_INTERVAL_SECONDS = readBoundedNumber(
  process.env.RECONCILE_INTERVAL_SECONDS,
  900,
  300,
  1_800
);

const CONSENSUS_REFRESH_INTERVAL_SECONDS = readBoundedNumber(
  process.env.CONSENSUS_REFRESH_INTERVAL_SECONDS,
  30,
  10,
  300
);

const HELIUS_WEBHOOK_URL =
  process.env.HELIUS_WEBHOOK_URL ??
  (process.env.NEXT_PUBLIC_SUPABASE_URL
    ? `${process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")}/functions/v1/helius-webhook`
    : "");
const HELIUS_EVENT_MODE = (
  process.env.HELIUS_EVENT_MODE ?? "auto"
).toLowerCase();

const MAX_HELIUS_WALLETS = Math.floor(
  readBoundedNumber(process.env.MAX_HELIUS_WALLETS, 6, 3, 25)
);
const HELIUS_CORE_WALLETS = Math.floor(
  readBoundedNumber(process.env.HELIUS_CORE_WALLETS, 4, 0, 25)
);
const HELIUS_ROTATION_HOURS = readBoundedNumber(
  process.env.HELIUS_ROTATION_HOURS,
  6,
  1,
  24
);

const WALLET_REFRESH_INTERVAL_SECONDS = readBoundedNumber(
  process.env.WALLET_REFRESH_INTERVAL_SECONDS,
  60,
  15,
  600
);

const EVENT_DEDUPE_MINUTES = readBoundedNumber(
  process.env.EVENT_DEDUPE_MINUTES,
  30,
  10,
  180
);

const USAGE_FLUSH_INTERVAL_SECONDS = readBoundedNumber(
  process.env.USAGE_FLUSH_INTERVAL_SECONDS,
  900,
  60,
  3_600
);

const SCALP_WINDOW_MINUTES = readBoundedNumber(
  process.env.SCALP_WINDOW_MINUTES,
  5,
  1,
  60
);

const ALERT_WINDOW_HOURS = readBoundedNumber(
  process.env.ALERT_WINDOW_HOURS,
  24,
  1,
  48
);

const MAX_SIGNATURES_PER_WALLET = Math.floor(
  readBoundedNumber(
    process.env.MAX_SIGNATURES_PER_WALLET,
    500,
    1,
    1_000
  )
);

const RPC_MIN_INTERVAL_MS = Math.floor(
  readBoundedNumber(
    process.env.RPC_MIN_INTERVAL_MS,
    200,
    125,
    10_000
  )
);

const MAX_TRADE_AGE_MS =
  readBoundedNumber(
    process.env.MAX_TRADE_AGE_SECONDS,
    120,
    30,
    3_600
  ) * 1_000;

const SIGNAL_MAX_AGE_MS =
  readBoundedNumber(
    process.env.SIGNAL_MAX_AGE_MINUTES,
    10,
    1,
    120
  ) * 60_000;

const MIN_TRACKED_TRADE_SOL = readBoundedNumber(
  process.env.MIN_TRACKED_TRADE_SOL,
  0.01,
  0,
  100
);

const MIN_WALLETS_FOR_ALERT = 3;
const MIN_SCORE_FOR_ALERT = Number(process.env.MIN_SCORE_FOR_ALERT ?? 8);
// Keep Helius requests sequential. A single global pacer still protects the
// worker if concurrency is raised in a future version.
const WALLET_POLL_CONCURRENCY = 1;
const MIN_LIQUIDITY_USD = 10_000;
const MIN_MARKET_CAP = 10_000;
const MAX_MARKET_CAP = 3_000_000;
const MIN_TOTAL_SOL = 1;

const supabase = getSupabaseAdmin();
const connection = getConnection();
const processInstanceId = randomUUID();
const usage = new HeliusUsageTracker();
const processedSignatures = new SignatureDeduper(
  EVENT_DEDUPE_MINUTES * 60_000
);
const inFlightSignatures = new Map<string, Promise<SignatureProcessResult>>();
const walletProcessingTails = new Map<string, Promise<void>>();
const walletSubscriptions = new Map<string, number>();
let webhookMode = false;
let lastWebhookAddressKey = "";
let lastWebhookCheckAt = 0;

const sleep = (ms: number) =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, ms)
  );

const rpcPacer = new RpcPacer(
  RPC_MIN_INTERVAL_MS,
  Date.now,
  sleep
);

function throwIfError(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>
): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(values.length);

  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function isRateLimitError(err: any): boolean {
  const msg = String(
    err?.message ?? err ?? ""
  );

  return (
    msg.includes("429") ||
    msg.includes("Too Many Requests")
  );
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retries = 3,
  trackHelius = false
): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err)) {
        if (trackHelius) {
          usage.increment("rateLimitErrors");
        }

        if (i === retries) {
          if (trackHelius) {
            usage.increment("rpcFailures");
          }

          console.error(
            `[429] ${label}. Retry budget exhausted`
          );
          return null;
        }

        const waitMs = getRateLimitDelayMs(i);

        console.warn(
          `[429] ${label}. Waiting ${waitMs}ms`
        );

        await sleep(waitMs);
        continue;
      }

      console.error(
        `[error] ${label}:`,
        err
      );

      if (trackHelius) {
        usage.increment("rpcFailures");
      }

      return null;
    }
  }

  return null;
}

async function checkpointWalletCursor(
  walletAddress: string,
  signature: string
): Promise<void> {
  const { error } = await supabase
    .from("wallets")
    .update({
      last_signature: signature,
    })
    .eq("address", walletAddress);

  throwIfError("Failed to checkpoint wallet cursor", error);
}

async function fetchWalletSignatures(
  walletAddress: string,
  untilSignature: string | null,
  limit: number
) {
  return withRetry(
    `fetch signatures ${walletAddress.slice(0, 6)}`,
    () =>
      rpcPacer.run(() =>
        fetchNewSignatures(
          connection,
          walletAddress,
          untilSignature,
          limit,
          () => usage.increment("signatureRequests")
        )
      ),
    3,
    true
  );
}

async function fetchParsedTransaction(signature: string) {
  return withRetry(
    `fetch tx ${signature.slice(0, 8)}`,
    () =>
      rpcPacer.run(() => {
        usage.increment("transactionRequests");
        return getParsedTx(connection, signature);
      }),
    3,
    true
  );
}

type SignatureProcessResult =
  | "already_processed"
  | "retry"
  | "ignored"
  | "duplicate"
  | "new_trade";

async function processWalletSignatureInner(
  walletAddress: string,
  signature: string
): Promise<SignatureProcessResult> {
  const key = signatureEventKey(walletAddress, signature);
  const tx = await fetchParsedTransaction(signature);

  if (!tx) {
    return "retry";
  }

  const trade = extractTrade(tx, walletAddress);

  if (!trade) {
    processedSignatures.mark(key);
    return "ignored";
  }

  // Delayed swaps must not train the live entry logic or create late paper
  // positions. The reconciliation loop still advances the wallet cursor.
  if (
    !isFreshTimestamp(
      trade.txTime,
      Date.now(),
      MAX_TRADE_AGE_MS
    )
  ) {
    processedSignatures.mark(key);
    return "ignored";
  }

  if (trade.solAmount < MIN_TRACKED_TRADE_SOL) {
    processedSignatures.mark(key);
    return "ignored";
  }

  const windowStart = new Date(
    trade.txTime.getTime() - SCALP_WINDOW_MINUTES * 60_000
  );
  const windowEnd = new Date(
    trade.txTime.getTime() + SCALP_WINDOW_MINUTES * 60_000
  );
  const oppositeSide = trade.side === "buy" ? "sell" : "buy";

  const { data: nearbyOpposite, error: nearbyError } = await supabase
    .from("wallet_transactions")
    .select("id")
    .eq("wallet_address", walletAddress)
    .eq("token_mint", trade.tokenMint)
    .eq("side", oppositeSide)
    .gte("tx_time", windowStart.toISOString())
    .lte("tx_time", windowEnd.toISOString());
  throwIfError("Failed to check scalp window", nearbyError);

  const oppositeIds = (nearbyOpposite ?? []).map((row) => row.id);
  const isScalp = oppositeIds.length > 0;

  if (oppositeIds.length > 0) {
    const { error: oppositeUpdateError } = await supabase
      .from("wallet_transactions")
      .update({ is_scalp: true })
      .in("id", oppositeIds);
    throwIfError(
      "Failed to mark opposite scalp trades",
      oppositeUpdateError
    );
  }

  const { data: storedRows, error: tradeError } = await supabase
    .from("wallet_transactions")
    .upsert(
      {
        wallet_address: walletAddress,
        signature: trade.signature,
        token_mint: trade.tokenMint,
        side: trade.side,
        sol_amount: trade.solAmount,
        token_amount: trade.tokenAmount,
        tx_time: trade.txTime.toISOString(),
        is_scalp: isScalp,
      },
      {
        onConflict: "wallet_address,signature,token_mint,side",
        ignoreDuplicates: true,
      }
    )
    .select("id");
  throwIfError("Failed to store wallet transaction", tradeError);

  processedSignatures.mark(key);

  if (!storedRows?.length) {
    return "duplicate";
  }

  usage.increment("storedTrades");
  console.log(
    `[trade] ${walletAddress.slice(0, 6)}… ` +
      `${trade.side.toUpperCase()} ${trade.tokenMint.slice(0, 6)}… ` +
      `${trade.solAmount.toFixed(3)} SOL` +
      `${isScalp ? " (SCALP)" : ""}`
  );

  return "new_trade";
}

async function processWalletSignature(
  walletAddress: string,
  signature: string
): Promise<SignatureProcessResult> {
  const key = signatureEventKey(walletAddress, signature);

  if (processedSignatures.has(key)) {
    return "already_processed";
  }

  const existing = inFlightSignatures.get(key);
  if (existing) return existing;

  // WebSocket and reconciliation work share this per-wallet chain. Different
  // wallets may run concurrently, while one wallet's trades remain ordered so
  // opposite-side scalp detection cannot race itself.
  const previous = walletProcessingTails.get(walletAddress) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() => processWalletSignatureInner(walletAddress, signature))
    .finally(() => inFlightSignatures.delete(key));
  const tail = task.then(
    () => undefined,
    () => undefined
  );

  inFlightSignatures.set(key, task);
  walletProcessingTails.set(walletAddress, tail);
  void tail.finally(() => {
    if (walletProcessingTails.get(walletAddress) === tail) {
      walletProcessingTails.delete(walletAddress);
    }
  });
  return task;
}

async function pollWallet(wallet: {
  address: string;
  last_signature: string | null;
}): Promise<number> {
  // A newly added wallet must start at "now". Replaying its history creates
  // false consensus, burns RPC quota, and can loop forever if Railway restarts
  // before the old cursor-at-end implementation finishes.
  if (!wallet.last_signature) {
    const latest = await fetchWalletSignatures(
      wallet.address,
      null,
      1
    );

    const latestSignature = latest?.[0]?.signature;

    if (latestSignature) {
      await checkpointWalletCursor(
        wallet.address,
        latestSignature
      );

      console.log(
        `[cursor] ${wallet.address.slice(0, 6)}… initialized; ` +
          "historical transactions skipped"
      );
    }

    return 0;
  }

  // A filtered enhanced webhook already delivered and parsed every successful
  // SWAP. Reconciliation only keeps a recent cursor so a future fallback does
  // not replay webhook-era activity through getTransaction.
  if (webhookMode) {
    const latest = await fetchWalletSignatures(wallet.address, null, 1);
    const latestSignature = latest?.[0]?.signature;
    if (latestSignature && latestSignature !== wallet.last_signature) {
      await checkpointWalletCursor(wallet.address, latestSignature);
    }
    return 0;
  }

  const sigs = await fetchWalletSignatures(
    wallet.address,
    wallet.last_signature,
    MAX_SIGNATURES_PER_WALLET
  );

  if (!sigs?.length) {
    return 0;
  }

  if (sigs.length === MAX_SIGNATURES_PER_WALLET) {
    console.warn(
      `[cursor] ${wallet.address.slice(0, 6)}… backlog capped at ` +
        `${MAX_SIGNATURES_PER_WALLET}; WebSocket delivery remains primary`
    );
  }

  let newTrades = 0;

  for (const sigInfo of sigs) {
    const result = await processWalletSignature(
      wallet.address,
      sigInfo.signature
    );

    // Never advance past a transaction we failed to inspect. The next cycle
    // will retry it instead of silently losing a possible trade.
    if (result === "retry") {
      console.warn(
        `[cursor] ${wallet.address.slice(0, 6)}… stopped before ` +
          `${sigInfo.signature.slice(0, 8)} after RPC failure`
      );
      break;
    }

    // WebSocket processing never moves cursors because notifications can arrive
    // out of order. Reconciliation owns ordered checkpointing.
    await checkpointWalletCursor(
      wallet.address,
      sigInfo.signature
    );

    if (result === "new_trade") {
      newTrades += 1;
    }
  }

  return newTrades;
}

async function recomputeConsensus(): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(
    now -
      ALERT_WINDOW_HOURS *
        60 *
        60 *
        1000
  ).toISOString();
  const freshSignalCutoff = new Date(
    now - SIGNAL_MAX_AGE_MS
  );

  const { data: buys, error } =
    await supabase
      .from("wallet_transactions")
      .select(
        "wallet_address, token_mint, sol_amount, tx_time"
      )
      .eq("side", "buy")
      .eq("is_scalp", false)
      .gte("tx_time", windowStart);

  if (error) {
    console.error(
      "Failed to load buys:",
      error
    );

    return;
  }

  if (!buys?.length) {
    return;
  }

  const byToken = new Map<
    string,
    {
      wallets: Set<string>;
      walletSol: Map<string, number>;
      totalSol: number;
      first: Date;
      last: Date;
    }
  >();

  for (const buy of buys) {
    const current =
      byToken.get(
        buy.token_mint
      ) ?? {
        wallets:
          new Set<string>(),
        walletSol:
          new Map<string, number>(),
        totalSol: 0,
        first:
          new Date(buy.tx_time),
        last:
          new Date(buy.tx_time),
      };

    current.wallets.add(
      buy.wallet_address
    );

    current.walletSol.set(
      buy.wallet_address,
      (current.walletSol.get(buy.wallet_address) ?? 0) +
        Number(buy.sol_amount)
    );

    current.totalSol += Number(
      buy.sol_amount
    );

    const txTime = new Date(
      buy.tx_time
    );

    if (txTime < current.first) {
      current.first = txTime;
    }

    if (txTime > current.last) {
      current.last = txTime;
    }

    byToken.set(
      buy.token_mint,
      current
    );
  }

  const { data: recentAlerts, error: recentAlertsError } =
    await supabase
      .from("alerts_sent")
      .select("token_mint")
      .gte("sent_at", windowStart);

  if (recentAlertsError) {
    console.error(
      "Failed to load recent alert deduplication state:",
      recentAlertsError
    );
    return;
  }

  const recentlyAlertedMints = new Set(
    (recentAlerts ?? []).map((row) => row.token_mint)
  );

  // Do not spend external API calls rescoring every token bought during the
  // whole 24-hour window. Only new raw consensus candidates need market data.
  // This keeps each monitor cycle short as transaction history grows.
  const candidates = Array.from(byToken.entries()).filter(
    ([tokenMint, agg]) =>
      agg.wallets.size >= MIN_WALLETS_FOR_ALERT &&
      agg.totalSol >= MIN_TOTAL_SOL &&
      agg.last >= freshSignalCutoff &&
      !recentlyAlertedMints.has(tokenMint)
  );

  console.log(
    `[consensus] ${byToken.size} tokens in window; ` +
      `${candidates.length} new raw candidates`
  );

  for (const [
    tokenMint,
    agg,
  ] of candidates) {
    await sleep(700);

    const walletsCount =
      agg.wallets.size;

    const market = await withRetry(
      `market data ${tokenMint.slice(
        0,
        6
      )}`,
      () =>
        fetchTokenMarketData(
          tokenMint
        )
    );

    if (!market) {
      continue;
    }

    const marketCap =
      market.marketCap ?? 0;

    const liquidity =
      market.liquidityUsd ?? 0;

    const { data: sellRows, error: sellError } =
      await supabase
        .from("wallet_transactions")
        .select("wallet_address")
        .eq(
          "token_mint",
          tokenMint
        )
        .eq("side", "sell")
        .eq("is_scalp", false)
        .gte(
          "tx_time",
          windowStart
        );
    throwIfError("Failed to load token sells", sellError);

    const sellingWallets =
      new Set(
        (sellRows ?? []).map(
          (row) =>
            row.wallet_address
        )
      );

    const dumpDetected =
      sellingWallets.size >=
      Math.max(
        2,
        Math.ceil(
          walletsCount / 2
        )
      );

    const score = computeScore({
      walletsCount,
      liquidityUsd:
        market.liquidityUsd,
      marketCap:
        market.marketCap,
      holders:
        market.holders,
      holdersPrev:
        null,
      dumpDetected,
      scalpDetected:
        false,
    });

    const { error: scoreError } = await supabase
      .from("token_scores")
      .upsert(
        {
          token_mint:
            tokenMint,
          token_symbol:
            market.symbol,
          token_name:
            market.name,
          wallets_count:
            walletsCount,
          total_sol_bought:
            agg.totalSol,
          first_buy_time:
            agg.first.toISOString(),
          last_buy_time:
            agg.last.toISOString(),
          market_cap:
            market.marketCap,
          liquidity_usd:
            market.liquidityUsd,
          holders:
            market.holders,
          dump_flag:
            dumpDetected,
          scalp_flag:
            false,
          score,
          updated_at:
            new Date().toISOString(),
        },
        {
          onConflict:
            "token_mint",
        }
      );
    throwIfError("Failed to store token score", scoreError);

    console.log({
      token:
        market.symbol,
      wallets:
        walletsCount,
      score,
      liquidity,
      marketCap,
      totalSol:
        agg.totalSol,
      dumpDetected,
    });

    const passesAlertFilter =
      walletsCount >=
        MIN_WALLETS_FOR_ALERT &&
      score >=
        MIN_SCORE_FOR_ALERT &&
      liquidity >=
        MIN_LIQUIDITY_USD &&
      marketCap >=
        MIN_MARKET_CAP &&
      marketCap <=
        MAX_MARKET_CAP &&
      agg.totalSol >=
        MIN_TOTAL_SOL;

    if (!passesAlertFilter) {
      continue;
    }

    const { data: alreadyAlerted, error: alertLookupError } = await supabase
      .from("alerts_sent")
      .select("id")
      .eq(
        "token_mint",
        tokenMint
      )
      .gte(
        "sent_at",
        windowStart
      )
      .limit(1);
    throwIfError("Failed to check alert deduplication", alertLookupError);

    if (alreadyAlerted?.length) {
      continue;
    }

    console.log(
      "🚨 Wallet consensus alert"
    );

    console.log(
      `Token: ${market.symbol}`
    );

    console.log(
      `Wallets buying: ${walletsCount}`
    );

    console.log(
      `Score: ${score}`
    );

    console.log(
      `Liquidity: ${liquidity}`
    );

    console.log(
      `Market cap: ${marketCap}`
    );

    console.log(
      `Total SOL bought: ${agg.totalSol.toFixed(
        2
      )}`
    );

    // --- Phase 3: trust-weighted scoring ---
    // This is purely additive — it never changes passesAlertFilter above,
    // so the existing minimum-wallet-count / minimum-score gate and
    // "no single wallet can trigger an alert alone" rule are untouched.
    // It only refines the confidence context shown alongside an alert
    // that already passed the real gate on its own.
    const participantAddresses = Array.from(agg.wallets);
    const trustScoreMap = await getTrustScoresForWallets(
      participantAddresses
    );

    const walletContributions = participantAddresses.map((address) => ({
      address,
      // Wallets with no wallet_performance row yet (new/unseen) are
      // treated as neutral (50), same as a brand-new wallet would score
      // from computeTrustScore() itself.
      trustScore: trustScoreMap.get(address) ?? 50,
    }));

    const weighted = computeWeightedWalletScore(walletContributions);

    console.log(
      `[trust] ${market.symbol} confidence ${weighted.confidenceGrade} | ` +
        `weighted score ${weighted.weightedWalletScore} (raw ${walletsCount}) | ` +
        `avg trust ${weighted.averageTrustScore}`
    );
    console.log(
      "[trust] Per-wallet contribution:",
      weighted.perWalletContribution
        .map(
          (c) =>
            `${c.address.slice(0, 6)}…=trust:${c.trustScore},weight:${c.weight}`
        )
        .join(" | ")
    );

    await onAlert({
      tokenSymbol:
        market.symbol,
      mint:
        tokenMint,
      score,
      walletCount:
        walletsCount,
      totalBoughtSol:
        agg.totalSol,
      marketCapUsd:
        market.marketCap,
      liquidityUsd:
        market.liquidityUsd,
      weightedWalletScore: weighted.weightedWalletScore,
      averageTrustScore: weighted.averageTrustScore,
      confidenceGrade: weighted.confidenceGrade,
    }).catch((err) =>
      console.error(
        "[paper-trader] onAlert failed:",
        err
      )
    );

    await sendTelegramAlert(
      formatConsensusAlert({
        symbol:
          market.symbol,
        tokenMint,
        walletsCount,
        totalSol:
          agg.totalSol,
        marketCap:
          market.marketCap,
        liquidityUsd:
          market.liquidityUsd,
        score,
        weightedWalletScore: weighted.weightedWalletScore,
        averageTrustScore: weighted.averageTrustScore,
        confidenceGrade: weighted.confidenceGrade,
      })
    );

    // Single timestamp shared by alerts_sent and alert_participants so
    // Phase 2's wallet-performance matching lines up exactly.
    const alertTimestamp = new Date().toISOString();

    const { error: alertInsertError } = await supabase
      .from("alerts_sent")
      .insert({
        token_mint:
          tokenMint,
        wallets_count:
          walletsCount,
        sent_at: alertTimestamp,
      });
    throwIfError("Failed to record sent alert", alertInsertError);

    // Phase 2: record which wallets participated in this alert, for
    // wallet-performance tracking going forward.
    const participantRows = participantAddresses.map((address) => ({
      token_mint: tokenMint,
      wallet_address: address,
      alert_sent_at: alertTimestamp,
      sol_amount: agg.walletSol.get(address) ?? 0,
    }));

    if (participantRows.length > 0) {
      const { error: participantsError } = await supabase
        .from("alert_participants")
        .upsert(participantRows, {
          onConflict: "token_mint,wallet_address,alert_sent_at",
        });

      if (participantsError) {
        console.error(
          "[paper-trader] Failed to record alert_participants:",
          participantsError
        );
      }
    }
  }
}

let consensusTimer: ReturnType<typeof setTimeout> | null = null;
let consensusRunning = false;
let consensusPending = false;

function scheduleConsensusRecompute(): void {
  consensusPending = true;
  if (consensusTimer || consensusRunning) return;

  consensusTimer = setTimeout(() => {
    consensusTimer = null;
    void runScheduledConsensus();
  }, 1_500);
}

async function runScheduledConsensus(): Promise<void> {
  if (consensusRunning) return;
  consensusRunning = true;
  consensusPending = false;

  try {
    await recomputeConsensus();
  } catch (error) {
    console.error("[consensus] Event-driven recompute failed:", error);
  } finally {
    consensusRunning = false;

    if (consensusPending) {
      scheduleConsensusRecompute();
    }
  }
}

const walletEventQueues = new Map<
  string,
  SerialEventQueue<WalletSignatureEvent>
>();

function totalEventQueueDepth(): number {
  let total = 0;
  for (const queue of walletEventQueues.values()) total += queue.depth;
  return total;
}

function getWalletEventQueue(
  walletAddress: string
): SerialEventQueue<WalletSignatureEvent> {
  const existing = walletEventQueues.get(walletAddress);
  if (existing) return existing;

  const queue = new SerialEventQueue<WalletSignatureEvent>(
    async (event) => {
      const result = await processWalletSignature(
        event.walletAddress,
        event.signature
      );

      if (result === "new_trade") {
        const latencyMs = Math.max(0, Date.now() - event.receivedAt);
        console.log(
          `[websocket] processed ${event.signature.slice(0, 8)} in ` +
            `${latencyMs}ms; queue=${totalEventQueueDepth()}`
        );
        scheduleConsensusRecompute();
      }
    },
    (error, event) => {
      console.error(
        `[websocket] ${event.walletAddress.slice(0, 6)}… ` +
          `${event.signature.slice(0, 8)} failed:`,
        error
      );
    },
    () => usage.observeQueueDepth(totalEventQueueDepth())
  );
  walletEventQueues.set(walletAddress, queue);
  return queue;
}

const activeWalletAddresses = new Set<string>();

async function syncHeliusWebhook(addresses: string[]): Promise<boolean> {
  if (HELIUS_EVENT_MODE === "websocket") {
    webhookMode = false;
    return false;
  }

  const rpcUrl = process.env.HELIUS_RPC_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rpcUrl || !serviceRoleKey || !HELIUS_WEBHOOK_URL) {
    webhookMode = false;
    return false;
  }

  const addressKey = [...addresses].sort().join(",");
  const now = Date.now();
  if (
    webhookMode &&
    addressKey === lastWebhookAddressKey &&
    now - lastWebhookCheckAt < 10 * 60_000
  ) {
    return true;
  }

  const result = await ensureHeliusSwapWebhook({
    rpcUrl,
    serviceRoleKey,
    webhookUrl: HELIUS_WEBHOOK_URL,
    accountAddresses: addresses,
  });
  lastWebhookCheckAt = now;

  if (!result.active) {
    webhookMode = false;
    console.warn(
      `[helius-webhook] ${result.action}: ${result.message ?? "not active"}; ` +
        "using WebSocket fallback"
    );
    return false;
  }

  if (!webhookMode || result.action !== "existing") {
    console.log(
      `[helius-webhook] ${result.action}; filtered SWAP delivery active for ` +
        `${addresses.length} wallets`
    );
  }
  webhookMode = true;
  lastWebhookAddressKey = addressKey;
  return true;
}

function handleWalletLogs(walletAddress: string, logs: Logs): void {
  usage.increment("websocketNotifications");
  usage.increment(
    "websocketBytes",
    Buffer.byteLength(JSON.stringify(logs), "utf8")
  );

  if (logs.err || !activeWalletAddresses.has(walletAddress)) {
    return;
  }

  const key = signatureEventKey(walletAddress, logs.signature);
  const enqueued = getWalletEventQueue(walletAddress).enqueue(key, {
    walletAddress,
    signature: logs.signature,
    receivedAt: Date.now(),
  });

  if (!enqueued) {
    usage.increment("duplicateEvents");
  }
}

async function syncWalletSubscriptions(): Promise<void> {
  const { data: wallets, error } = await supabase
    .from("wallets")
    .select("address")
    .eq("active", true);

  if (error) {
    console.error("[websocket] Failed to refresh wallet list:", error);
    return;
  }

  const desired = new Set((wallets ?? []).map((wallet) => wallet.address));
  activeWalletAddresses.clear();
  for (const address of desired) activeWalletAddresses.add(address);

  const addresses = [...desired];
  const trustScores = await getTrustScoresForWallets(addresses);
  const selection = selectHeliusWallets({
    addresses,
    trustScores,
    limit: MAX_HELIUS_WALLETS,
    coreCount: HELIUS_CORE_WALLETS,
    rotationHours: HELIUS_ROTATION_HOURS,
  });
  const webhookActive = await syncHeliusWebhook(selection.selected);

  if (webhookActive) {
    for (const [address, subscriptionId] of walletSubscriptions) {
      try {
        await connection.removeOnLogsListener(subscriptionId);
      } catch (error) {
        console.warn(
          `[websocket] Failed to close fallback subscription ${address.slice(0, 6)}…:`,
          error
        );
      } finally {
        walletSubscriptions.delete(address);
      }
    }
    console.log("[helius-webhook] WebSocket fallback is idle");
    return;
  }

  for (const [address, subscriptionId] of walletSubscriptions) {
    if (desired.has(address)) continue;

    try {
      await connection.removeOnLogsListener(subscriptionId);
      walletSubscriptions.delete(address);
      console.log(`[websocket] unsubscribed ${address.slice(0, 6)}…`);
    } catch (error) {
      console.warn(
        `[websocket] Failed to unsubscribe ${address.slice(0, 6)}…:`,
        error
      );
    }
  }

  for (const address of desired) {
    if (walletSubscriptions.has(address)) continue;

    try {
      const subscriptionId = connection.onLogs(
        new PublicKey(address),
        (logs) => handleWalletLogs(address, logs),
        "confirmed"
      );
      walletSubscriptions.set(address, subscriptionId);
      console.log(`[websocket] subscribed ${address.slice(0, 6)}…`);
    } catch (error) {
      console.error(
        `[websocket] Failed to subscribe ${address.slice(0, 6)}…:`,
        error
      );
    }
  }

  console.log(
    `[websocket] ${walletSubscriptions.size}/${desired.size} wallet subscriptions active`
  );
}

let usagePersistPromise: Promise<void> | null = null;

function persistHeliusUsage(): Promise<void> {
  if (usagePersistPromise) return usagePersistPromise;

  usagePersistPromise = persistHeliusUsageInner().finally(() => {
    usagePersistPromise = null;
  });
  return usagePersistPromise;
}

async function persistHeliusUsageInner(): Promise<void> {
  const snapshot = usage.snapshot();
  const hasActivity =
    snapshot.signatureRequests > 0 ||
    snapshot.transactionRequests > 0 ||
    snapshot.websocketNotifications > 0 ||
    snapshot.rateLimitErrors > 0 ||
    snapshot.rpcFailures > 0;

  if (!hasActivity) return;

  const { error } = await supabase
    .from("monitor_usage_samples")
    .upsert(
      {
        instance_id: processInstanceId,
        period_started_at: snapshot.periodStartedAt,
        recorded_at: snapshot.capturedAt,
        signature_requests: snapshot.signatureRequests,
        transaction_requests: snapshot.transactionRequests,
        webhook_events: snapshot.webhookEvents,
        websocket_notifications: snapshot.websocketNotifications,
        websocket_bytes: snapshot.websocketBytes,
        rate_limit_errors: snapshot.rateLimitErrors,
        rpc_failures: snapshot.rpcFailures,
        stored_trades: snapshot.storedTrades,
        duplicate_events: snapshot.duplicateEvents,
        max_queue_depth: snapshot.maxQueueDepth,
        mode: webhookMode ? "webhook" : "websocket",
      },
      { onConflict: "instance_id,period_started_at" }
    );

  if (error) {
    console.error("[helius-usage] Failed to save usage sample:", error);
    return;
  }

  usage.commit(snapshot);
  console.log(
    `[helius-usage] estimated ${estimateHeliusCredits({
      signatureRequests: snapshot.signatureRequests,
      transactionRequests: snapshot.transactionRequests,
      webhookEvents: snapshot.webhookEvents,
      websocketBytes: snapshot.websocketBytes,
    })} credits since ${snapshot.periodStartedAt}; ` +
      `${snapshot.rateLimitErrors} rate limits; max queue ${snapshot.maxQueueDepth}`
  );
}

async function runCycle(): Promise<void> {
  console.log(
    `\n=== Reconciliation cycle @ ${new Date().toISOString()} ===`
  );

  const { data: wallets, error } =
    await supabase
      .from("wallets")
      .select(
        "address, last_signature"
      )
      .eq("active", true);

  if (error) {
    console.error(
      "Failed to load wallets:",
      error
    );

    return;
  }

  if (!wallets?.length) {
    console.log(
      "No active wallets configured yet."
    );

    return;
  }

  console.log(
    `Monitoring ${wallets.length} wallets`
  );

  const tradeCounts = await mapWithConcurrency(
    wallets,
    WALLET_POLL_CONCURRENCY,
    async (wallet) => {
    try {
      return await pollWallet(wallet);
    } catch (error) {
      console.error(`[wallet] ${wallet.address.slice(0, 6)}… poll failed:`, error);
      return 0;
    }
    }
  );

  const newTrades = tradeCounts.reduce(
    (total, count) => total + count,
    0
  );

  if (newTrades > 0) {
    scheduleConsensusRecompute();
  } else {
    console.log(
      "[consensus] skipped; no new significant trades"
    );
  }

  console.log(`=== Reconciliation complete: ${newTrades} new trades ===`);
}

async function main(): Promise<void> {
  console.log(
    "Solana wallet tracker worker starting in filtered-webhook-first mode."
  );
  console.log(
    `RPC pacing: one request every ${RPC_MIN_INTERVAL_MS}ms; ` +
      `reconciliation every ${RECONCILE_INTERVAL_SECONDS}s; ` +
      `fresh trades only (${MAX_TRADE_AGE_MS / 1_000}s); ` +
      `minimum ${MIN_TRACKED_TRADE_SOL} SOL`
  );

  await syncWalletSubscriptions();

  // Webhook inserts happen in the public HTTPS route, so refresh consensus on
  // a small database-only cadence. This uses no Helius credits.
  setInterval(() => scheduleConsensusRecompute(), CONSENSUS_REFRESH_INTERVAL_SECONDS * 1_000);

  let syncingSubscriptions = false;
  setInterval(() => {
    if (syncingSubscriptions) return;
    syncingSubscriptions = true;
    syncWalletSubscriptions()
      .catch((error) =>
        console.error("[websocket] Wallet refresh failed:", error)
      )
      .finally(() => {
        syncingSubscriptions = false;
      });
  }, WALLET_REFRESH_INTERVAL_SECONDS * 1_000);

  let flushingUsage = false;
  setInterval(() => {
    if (flushingUsage) return;
    flushingUsage = true;
    persistHeliusUsage()
      .catch((error) =>
        console.error("[helius-usage] Flush failed:", error)
      )
      .finally(() => {
        flushingUsage = false;
      });
  }, USAGE_FLUSH_INTERVAL_SECONDS * 1_000);

  if (
    process.env
      .TELEGRAM_BOT_TOKEN &&
    process.env
      .TELEGRAM_CHAT_ID
  ) {
    await sendTelegramAlert(
      `✅ Solana wallet tracker started in credit-saving ${
        webhookMode ? "filtered webhook" : "WebSocket fallback"
      } mode. Telegram alerts are working.`
    );
  } else {
    console.log(
      "Telegram not configured."
    );
  }

  let checkingPositions = false;
  setInterval(async () => {
    if (checkingPositions) return;
    checkingPositions = true;
    try {
      await checkPositions();
    } catch (err) {
      console.error("[paper-trader] checkPositions failed:", err);
    } finally {
      checkingPositions = false;
    }
  }, 5000);

  setInterval(() => {
    sendDailyPaperReportIfDue().catch(
      (err) =>
        console.error(
          "[paper-trader] daily report check failed:",
          err
        )
    );
  }, 60_000);

  // Phase 2: recompute wallet_performance every 30 minutes. Trust
  // scores used for Phase 3 weighting are only as fresh as this run.
  setInterval(() => {
    computeAndStoreWalletPerformance().catch((err) =>
      console.error(
        "[wallet-performance] Periodic recompute failed:",
        err
      )
    );
  }, 30 * 60_000);

  // Reporting and analytics are maintenance work. Never delay live event
  // processing while they run.
  void sendDailyPaperReportIfDue().catch((err) =>
    console.error("[paper-trader] Initial daily report check failed:", err)
  );
  void computeAndStoreWalletPerformance().catch((err) =>
    console.error("[wallet-performance] Initial recompute failed:", err)
  );
  while (true) {
    const startedAt = Date.now();
    await runCycle().catch((error) =>
      console.error("[monitor] Reconciliation failed:", error)
    );
    const elapsed = Date.now() - startedAt;
    const interval = RECONCILE_INTERVAL_SECONDS * 1_000;
    await sleep(Math.max(1_000, interval - elapsed));
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[monitor] ${signal} received; saving usage before exit`);

  await persistHeliusUsage().catch((error) =>
    console.error("[helius-usage] Final flush failed:", error)
  );
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  console.error(
    "Fatal worker error:",
    err
  );

  process.exit(1);
});
