import "dotenv/config";
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

const configuredPollIntervalSeconds = Number(
  process.env.POLL_INTERVAL_SECONDS ?? 15
);

const POLL_INTERVAL_SECONDS =
  Number.isFinite(configuredPollIntervalSeconds) &&
  configuredPollIntervalSeconds >= 5
    ? configuredPollIntervalSeconds
    : 15;

const SCALP_WINDOW_MINUTES = Number(
  process.env.SCALP_WINDOW_MINUTES ?? 5
);

const ALERT_WINDOW_HOURS = Number(
  process.env.ALERT_WINDOW_HOURS ?? 24
);

const MIN_WALLETS_FOR_ALERT = 3;
const MIN_SCORE_FOR_ALERT = Number(process.env.MIN_SCORE_FOR_ALERT ?? 8);
const WALLET_POLL_CONCURRENCY = Math.max(1, Number(process.env.WALLET_POLL_CONCURRENCY ?? 4));
const MIN_LIQUIDITY_USD = 10_000;
const MIN_MARKET_CAP = 10_000;
const MAX_MARKET_CAP = 3_000_000;
const MIN_TOTAL_SOL = 1;

const supabase = getSupabaseAdmin();
const connection = getConnection();

const sleep = (ms: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

function throwIfError(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      await task(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
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
  retries = 3
): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err)) {
        const waitMs = 3000 * (i + 1);

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

      return null;
    }
  }

  return null;
}

async function pollWallet(wallet: {
  address: string;
  last_signature: string | null;
}): Promise<void> {
  let newest = wallet.last_signature;

  const sigs = await withRetry(
    `fetch signatures ${wallet.address.slice(
      0,
      6
    )}`,
    () =>
      fetchNewSignatures(
        connection,
        wallet.address,
        wallet.last_signature,
        250
      )
  );

  if (!sigs?.length) {
    return;
  }

  for (const sigInfo of sigs) {
    await sleep(500);

    const tx = await withRetry(
      `fetch tx ${sigInfo.signature.slice(
        0,
        8
      )}`,
      () =>
        getParsedTx(
          connection,
          sigInfo.signature
        )
    );

    if (!tx) {
      continue;
    }

    const trade = extractTrade(
      tx,
      wallet.address
    );

    newest = sigInfo.signature;

    if (!trade) {
      continue;
    }

    const windowStart = new Date(
      trade.txTime.getTime() -
        SCALP_WINDOW_MINUTES * 60_000
    );

    const windowEnd = new Date(
      trade.txTime.getTime() +
        SCALP_WINDOW_MINUTES * 60_000
    );

    const oppositeSide =
      trade.side === "buy"
        ? "sell"
        : "buy";

    const { data: nearbyOpposite, error: nearbyError } =
      await supabase
        .from("wallet_transactions")
        .select("id")
        .eq(
          "wallet_address",
          wallet.address
        )
        .eq(
          "token_mint",
          trade.tokenMint
        )
        .eq("side", oppositeSide)
        .gte(
          "tx_time",
          windowStart.toISOString()
        )
        .lte(
          "tx_time",
          windowEnd.toISOString()
        )
        .limit(1);
    throwIfError("Failed to check scalp window", nearbyError);

    const isScalp =
      !!nearbyOpposite?.length;

    const { error: tradeError } = await supabase
      .from("wallet_transactions")
      .upsert(
        {
          wallet_address:
            wallet.address,
          signature:
            trade.signature,
          token_mint:
            trade.tokenMint,
          side:
            trade.side,
          sol_amount:
            trade.solAmount,
          token_amount:
            trade.tokenAmount,
          tx_time:
            trade.txTime.toISOString(),
          is_scalp:
            isScalp,
        },
        {
          onConflict:
            "wallet_address,signature,token_mint,side",
        }
      );
    throwIfError("Failed to store wallet transaction", tradeError);

    console.log(
      `[trade] ${wallet.address.slice(
        0,
        6
      )}… ${trade.side.toUpperCase()} ` +
        `${trade.tokenMint.slice(
          0,
          6
        )}… ${trade.solAmount.toFixed(
          3
        )} SOL` +
        `${isScalp ? " (SCALP)" : ""}`
    );
  }

  if (
    newest &&
    newest !== wallet.last_signature
  ) {
    const { error: cursorError } = await supabase
      .from("wallets")
      .update({
        last_signature: newest,
      })
      .eq(
        "address",
        wallet.address
      );
    throwIfError("Failed to update wallet cursor", cursorError);
  }
}

async function recomputeConsensus(): Promise<void> {
  const windowStart = new Date(
    Date.now() -
      ALERT_WINDOW_HOURS *
        60 *
        60 *
        1000
  ).toISOString();

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

async function runCycle(): Promise<void> {
  console.log(
    `\n=== Monitor cycle @ ${new Date().toISOString()} ===`
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

  await mapWithConcurrency(wallets, WALLET_POLL_CONCURRENCY, async (wallet) => {
    try {
      await pollWallet(wallet);
    } catch (error) {
      console.error(`[wallet] ${wallet.address.slice(0, 6)}… poll failed:`, error);
    }
  });

  await recomputeConsensus();

  console.log(
    "=== Cycle complete ==="
  );
}

async function main(): Promise<void> {
  console.log(
    `Solana wallet tracker worker starting. Polling every ${POLL_INTERVAL_SECONDS} sec.`
  );

  if (
    process.env
      .TELEGRAM_BOT_TOKEN &&
    process.env
      .TELEGRAM_CHAT_ID
  ) {
    await sendTelegramAlert(
      "✅ Solana wallet tracker started. Telegram alerts are working."
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

  // Reporting and analytics are maintenance work. Never delay the first
  // wallet-polling cycle (and therefore paper trading) while they run.
  void sendDailyPaperReportIfDue().catch((err) =>
    console.error("[paper-trader] Initial daily report check failed:", err)
  );
  void computeAndStoreWalletPerformance().catch((err) =>
    console.error("[wallet-performance] Initial recompute failed:", err)
  );
  while (true) {
    const startedAt = Date.now();
    await runCycle().catch((error) => console.error("[monitor] Cycle failed:", error));
    const elapsed = Date.now() - startedAt;
    const interval = POLL_INTERVAL_SECONDS * 1000;
    await sleep(Math.max(1_000, interval - elapsed));
  }
}

main().catch((err) => {
  console.error(
    "Fatal worker error:",
    err
  );

  process.exit(1);
});

