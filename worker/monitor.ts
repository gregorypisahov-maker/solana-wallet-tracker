import "dotenv/config";
import { getConnection, fetchNewSignatures, getParsedTx, extractTrade } from "../lib/solana";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { computeScore } from "../lib/scoring";
import { sendTelegramAlert, formatConsensusAlert } from "../lib/telegram";

const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES ?? 2);
const SCALP_WINDOW_MINUTES = Number(process.env.SCALP_WINDOW_MINUTES ?? 5);
const MIN_WALLETS_FOR_ALERT = Number(process.env.MIN_WALLETS_FOR_ALERT ?? 3);
const ALERT_WINDOW_HOURS = Number(process.env.ALERT_WINDOW_HOURS ?? 24);

const supabase = getSupabaseAdmin();
const connection = getConnection();

// ---------- Step 1: poll wallets for new trades ----------

async function pollWallet(wallet: { address: string; last_signature: string | null }) {
  let newest = wallet.last_signature;

  try {
    const sigs = await fetchNewSignatures(connection, wallet.address, wallet.last_signature, 25);
    if (!sigs.length) return;

    for (const sigInfo of sigs) {
      const tx = await getParsedTx(connection, sigInfo.signature);
      if (!tx) continue;

      const trade = extractTrade(tx, wallet.address);
      newest = sigInfo.signature;
      if (!trade) continue;

      // Anti-scalp check: does this wallet have an opposite-side trade on the
      // same token within SCALP_WINDOW_MINUTES? If so, both legs are a scalp.
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

      if (isScalp) {
        await supabase
          .from("wallet_transactions")
          .update({ is_scalp: true })
          .eq("wallet_address", wallet.address)
          .eq("token_mint", trade.tokenMint)
          .eq("side", oppositeSide)
          .gte("tx_time", windowStart.toISOString())
          .lte("tx_time", windowEnd.toISOString());
      }

      console.log(
        `[trade] ${wallet.address.slice(0, 6)}… ${trade.side.toUpperCase()} ${trade.tokenMint.slice(0, 6)}… ${trade.solAmount.toFixed(3)} SOL${isScalp ? " (SCALP)" : ""}`
      );
    }
  } catch (err) {
    console.error(`Failed polling wallet ${wallet.address}:`, err);
  } finally {
    if (newest && newest !== wallet.last_signature) {
      await supabase.from("wallets").update({ last_signature: newest }).eq("address", wallet.address);
    }
  }
}

// ---------- Step 2: aggregate consensus + score + alert ----------

async function recomputeConsensus() {
  const windowStart = new Date(Date.now() - ALERT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data: buys, error } = await supabase
    .from("wallet_transactions")
    .select("wallet_address, token_mint, sol_amount, tx_time")
    .eq("side", "buy")
    .eq("is_scalp", false)
    .gte("tx_time", windowStart);

  if (error) {
    console.error("Failed to load buys for consensus:", error);
    return;
  }
  if (!buys?.length) return;

  const byToken = new Map<
    string,
    { wallets: Set<string>; totalSol: number; first: Date; last: Date }
  >();

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

  const { data: scalpRows } = await supabase
    .from("wallet_transactions")
    .select("token_mint")
    .eq("is_scalp", true)
    .gte("tx_time", windowStart);
  const scalpTokens = new Set((scalpRows ?? []).map((r) => r.token_mint));

  for (const [tokenMint, agg] of byToken.entries()) {
    const walletsCount = agg.wallets.size;

    const market = await fetchTokenMarketData(tokenMint);

    const { data: existing } = await supabase
      .from("token_scores")
      .select("holders")
      .eq("token_mint", tokenMint)
      .maybeSingle();

    const holdersPrev = existing?.holders ?? null;

    const { data: sellRows } = await supabase
      .from("wallet_transactions")
      .select("wallet_address")
      .eq("token_mint", tokenMint)
      .eq("side", "sell")
      .gte("tx_time", windowStart);
    const sellingWallets = new Set((sellRows ?? []).map((r) => r.wallet_address));
    const dumpDetected = sellingWallets.size >= Math.max(2, Math.ceil(walletsCount / 2));

    const scalpDetected = scalpTokens.has(tokenMint);

    const score = computeScore({
      walletsCount,
      liquidityUsd: market.liquidityUsd,
      marketCap: market.marketCap,
      holders: market.holders,
      holdersPrev,
      dumpDetected,
      scalpDetected,
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
        holders_prev: holdersPrev,
        dump_flag: dumpDetected,
        scalp_flag: scalpDetected,
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
        await supabase.from("alerts_sent").insert({ token_mint: tokenMint, wallets_count: walletsCount });
      }
    }
  }
}

// ---------- Main loop ----------

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

  for (const wallet of wallets) {
    await pollWallet(wallet);
  }

  await recomputeConsensus();
  console.log("=== Cycle complete ===");
}

async function main() {
  console.log(`Solana wallet tracker worker starting. Polling every ${POLL_INTERVAL_MINUTES} min.`);
  await runCycle();
  setInterval(runCycle, POLL_INTERVAL_MINUTES * 60_000);
}

main().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
