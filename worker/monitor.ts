import "dotenv/config";
import { getConnection, fetchNewSignatures, getParsedTx, extractTrade } from "../lib/solana";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { computeScore } from "../lib/scoring";
import { sendTelegramAlert, formatConsensusAlert } from "../lib/telegram";

const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES ?? 5);
const SCALP_WINDOW_MINUTES = Number(process.env.SCALP_WINDOW_MINUTES ?? 5);
const MIN_WALLETS_FOR_ALERT = Number(process.env.MIN_WALLETS_FOR_ALERT ?? 3);
const ALERT_WINDOW_HOURS = Number(process.env.ALERT_WINDOW_HOURS ?? 24);

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
        console.warn(`[429] ${label}. Waiting ${waitMs}ms before retry ${i + 1}/${retries}`);
        await sleep(waitMs);
        continue;
      }

      console.error(`[error] ${label}:`, err);
      return null;
    }
  }

  console.error(`[failed] ${label} after retries`);
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

    const isScalp = !!nearbyOpposite && nearbyOpposite.length > 0;

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

  if (error || !buys?.length) return;

  const byToken = new Map<string, { wallets: Set<string>; totalSol: number; first: Date; last: Date }>();

  for (const b of buys) {
    const t = byToken.get(b.token_mint) ?? {
      wallets: new Set<string>(),
      totalSol: 0,
      first: new Date(b.tx_time),
      last: new Date(b.tx_time),
    };

    t.wallets.add(b.wallet_address);
    t.totalSol += Number(b.sol_amount);

    const txTime = new Date(b.tx_time);
    if (txTime < t.first) t.first = txTime;
    if (txTime > t.last) t.last = txTime;

    byToken.set(b.token_mint, t);
  }

  for (const [tokenMint, agg] of byToken.entries()) {
    await sleep(700);

    const market = await withRetry(
      `market data ${tokenMint.slice(0, 6)}`,
      () => fetchTokenMarketData(tokenMint)
    );

    if (!market) continue;

    const walletsCount = agg.wallets.size;

    const score = computeScore({
      walletsCount,
      liquidityUsd: market.liquidityUsd,
      marketCap: market.marketCap,
      holders: market.holders,
      holdersPrev: null,
      dumpDetected: false,
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
        score,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "token_mint" }
    );

    if (walletsCount >= MIN_WALLETS_FOR_ALERT) {
      const { data: alreadyAlerted } = await supabase
        .from("alerts_sent")
        .select("id")
        .eq("token_mint", tokenMint)
        .gte("sent_at", windowStart)
        .limit(1);

      if (!alreadyAlerted || alreadyAlerted.length === 0) {
        console.log("🚨 Wallet consensus alert");
        console.log(`Token: ${market.symbol}`);
        console.log(`Wallets buying: ${walletsCount}`);
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

        await supabase.from("alerts_sent").insert({
          token_mint: tokenMint,
          wallets_count: walletsCount,
        });
      }
    }
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

  await runCycle();
  setInterval(runCycle, POLL_INTERVAL_MINUTES * 60_000);
}

main().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
