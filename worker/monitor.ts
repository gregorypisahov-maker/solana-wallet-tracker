import "dotenv/config";
import { getConnection, fetchNewSignatures, getParsedTx, extractTrade } from "../lib/solana";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { computeScore } from "../lib/scoring";
import { sendTelegramAlert, formatConsensusAlert } from "../lib/telegram";
import { onAlert, checkPositions } from "../paper-trader/engine";

const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES ?? 5);
const SCALP_WINDOW_MINUTES = Number(process.env.SCALP_WINDOW_MINUTES ?? 5);
const ALERT_WINDOW_HOURS = Number(process.env.ALERT_WINDOW_HOURS ?? 24);

const MIN_WALLETS_FOR_ALERT = 3;
const MIN_SCORE_FOR_ALERT = 6;
const MIN_LIQUIDITY_USD = 10_000;
const MIN_MARKET_CAP = 10_000;
const MAX_MARKET_CAP = 3_000_000;
const MIN_TOTAL_SOL = 1;

const supabase = getSupabaseAdmin();
const connection = getConnection();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(err: any) {
  const msg = String(err?.message ?? err ?? "");
  return msg.includes("429") || msg.includes("Too Many Requests");
}

async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 3): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err)) {
        const waitMs = 3000 * (i + 1);
        console.warn(`[429] ${label}. Waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      console.error(`[error] ${label}:`, err);
      return null;
    }
  }
  return null;
}

async function pollWallet(wallet: { address: string; last_signature: string | null }) {
  let newest = wallet.last_signature;

  const sigs = await withRetry(
    `fetch signatures ${wallet.address.slice(0, 6)}`,
    () => fetchNewSignatures(connection, wallet.address, wallet.last_signature, 10)
  );

  if (!sigs?.length) return;

  for (const sigInfo of sigs) {
    await sleep(500);

    const tx = await withRetry(
      `fetch tx ${sigInfo.signature.slice(0, 8)}`,
      () => getParsedTx(connection, sigInfo.signature)
    );

    if (!tx) continue;

    const trade = extractTrade(tx, wallet.address);
    newest = sigInfo.signature;
    if (!trade) continue;

    const windowStart = new Date(trade.txTime.getTime() - SCALP_WINDOW_MINUTES * 60_000);
    const windowEnd = new Date(trade.txTime.getTime() + SCALP_WINDOW_MINUTES * 60_000);
    const oppositeSide = trade.side === "buy" ? "sell" : "buy";

    const { data: nearbyOpposite } = await supabase
      .from("wallet_transactions")
      .select("id")
      .eq("wallet_address", wallet.address)
      .eq("token_mint", trade.tokenMint)
      .eq("side", oppositeSide)
      .gte("tx_time", windowStart.toISOString())
      .lte("tx_time", windowEnd.toISOString())
      .limit(1);

    const isScalp = !!nearbyOpposite?.length;

    await supabase.from("wallet_transactions").upsert(
      {
        wallet_address: wallet.address,
        signature: trade.signature,
        token_mint: trade.tokenMint,
        side: trade.side,
        sol_amount: trade.solAmount,
        token_amount: trade.tokenAmount,
        tx_time: trade.txTime.toISOString(),
        is_scalp: isScalp,
      },
      { onConflict: "wallet_address,signature,token_mint,side" }
    );

    console.log(
      `[trade] ${wallet.address.slice(0, 6)}… ${trade.side.toUpperCase()} ${trade.tokenMint.slice(0, 6)}… ${trade.solAmount.toFixed(3)} SOL${isScalp ? " (SCALP)" : ""}`
    );
  }

  if (newest && newest !== wallet.last_signature) {
    await supabase.from("wallets").update({ last_signature: newest }).eq("address", wallet.address);
  }
}

async function recomputeConsensus() {
  const windowStart = new Date(Date.now() - ALERT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data: buys, error } = await supabase
    .from("wallet_transactions")
    .select("wallet_address, token_mint, sol_amount, tx_time")
    .eq("side", "buy")
    .eq("is_scalp", false)
    .gte("tx_time", windowStart);

  if (error) {
    console.error("Failed to load buys:", error);
    return;
  }

  if (!buys?.length) return;

  const byToken = new Map<string, { wallets: Set<string>; totalSol: number; first: Date; last: Date }>();

  for (const b of buys) {
    const current = byToken.get(b.token_mint) ?? {
      wallets: new Set<string>(),
      totalSol: 0,
      first: new Date(b.tx_time),
      last: new Date(b.tx_time),
    };

    current.wallets.add(b.wallet_address);
    current.totalSol += Number(b.sol_amount);

    const txTime = new Date(b.tx_time);
    if (txTime < current.first) current.first = txTime;
    if (txTime > current.last) current.last = txTime;

    byToken.set(b.token_mint, current);
  }

  for (const [tokenMint, agg] of byToken.entries()) {
    await sleep(700);

    const walletsCount = agg.wallets.size;

    const market = await withRetry(
      `market data ${tokenMint.slice(0, 6)}`,
      () => fetchTokenMarketData(tokenMint)
    );

    if (!market) continue;

    const marketCap = market.marketCap ?? 0;
    const liquidity = market.liquidityUsd ?? 0;

    const { data: sellRows } = await supabase
      .from("wallet_transactions")
      .select("wallet_address")
      .eq("token_mint", tokenMint)
      .eq("side", "sell")
      .gte("tx_time", windowStart);

    const sellingWallets = new Set((sellRows ?? []).map((r) => r.wallet_address));
    const dumpDetected = sellingWallets.size >= Math.max(2, Math.ceil(walletsCount / 2));

    const score = computeScore({
      walletsCount,
      liquidityUsd: market.liquidityUsd,
      marketCap: market.marketCap,
      holders: market.holders,
      holdersPrev: null,
      dumpDetected,
      scalpDetected: false,
    });

    await supabase.from("token_scores").upsert(
      {
        token_mint: tokenMint,
        token_symbol: market.symbol,
        token_name: market.name,
        wallets_count: walletsCount,
        total_sol_bought: agg.totalSol,
        first_buy_time: agg.first.toISOString(),
        last_buy_time: agg.last.toISOString(),
        market_cap: market.marketCap,
        liquidity_usd: market.liquidityUsd,
        holders: market.holders,
        dump_flag: dumpDetected,
        scalp_flag: false,
        score,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "token_mint" }
    );

    console.log({
      token: market.symbol,
      wallets: walletsCount,
      score,
      liquidity,
      marketCap,
      totalSol: agg.totalSol,
      dumpDetected,
    });

    const passesAlertFilter =
      walletsCount >= MIN_WALLETS_FOR_ALERT &&
      score >= MIN_SCORE_FOR_ALERT &&
      liquidity >= MIN_LIQUIDITY_USD &&
      marketCap >= MIN_MARKET_CAP &&
      marketCap <= MAX_MARKET_CAP &&
      agg.totalSol >= MIN_TOTAL_SOL;

    if (!passesAlertFilter) continue;

    const { data: alreadyAlerted } = await supabase
      .from("alerts_sent")
      .select("id")
      .eq("token_mint", tokenMint)
      .gte("sent_at", windowStart)
      .limit(1);

    if (alreadyAlerted?.length) continue;

    console.log("🚨 Wallet consensus alert");
    console.log(`Token: ${market.symbol}`);
    console.log(`Wallets buying: ${walletsCount}`);
    console.log(`Score: ${score}`);
    console.log(`Liquidity: ${liquidity}`);
    console.log(`Market cap: ${marketCap}`);
    console.log(`Total SOL bought: ${agg.totalSol.toFixed(2)}`);

    await sendTelegramAlert(
      formatConsensusAlert({
        symbol: market.symbol,
        tokenMint,
        walletsCount,
        totalSol: agg.totalSol,
        marketCap: market.marketCap,
        liquidityUsd: market.liquidityUsd,
        score,
      })
    );

    // --- Paper trading: feed the same alert data into the simulator ---
    await onAlert({
      tokenSymbol: market.symbol,
      mint: tokenMint,
      score,
      walletCount: walletsCount,
      totalBoughtSol: agg.totalSol,
      marketCapUsd: market.marketCap,
      liquidityUsd: market.liquidityUsd,
    }).catch((err) => console.error("[paper-trader] onAlert failed:", err));

    await supabase.from("alerts_sent").insert({
      token_mint: tokenMint,
      wallets_count: walletsCount,
    });
  }
}

async function runCycle() {
  console.log(`\n=== Monitor cycle @ ${new Date().toISOString()} ===`);

  const { data: wallets, error } = await supabase
    .from("wallets")
    .select("address, last_signature")
    .eq("active", true);

  if (error) {
    console.error("Failed to load wallets:", error);
    return;
  }

  if (!wallets?.length) {
    console.log("No active wallets configured yet.");
    return;
  }

  console.log(`Monitoring ${wallets.length} wallets`);

  for (const wallet of wallets) {
    await pollWallet(wallet);
    await sleep(1500);
  }

  await recomputeConsensus();
  console.log("=== Cycle complete ===");
}

async function main() {
  console.log(`Solana wallet tracker worker starting. Polling every ${POLL_INTERVAL_MINUTES} min.`);

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await sendTelegramAlert("✅ Solana wallet tracker started. Telegram alerts are working.");
  } else {
    console.log("Telegram not configured.");
  }

  // Paper trader: check open simulated positions every 5s for take-profit / stop-loss
  setInterval(() => {
    checkPositions().catch((err) => console.error("[paper-trader] checkPositions failed:", err));
  }, 5000);

  await runCycle();
  setInterval(runCycle, POLL_INTERVAL_MINUTES * 60_000);
}

main().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
