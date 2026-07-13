import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { getPriceUsd } from "@/paper-trader/priceFeed";

export const dynamic = "force-dynamic";

const maskAddress = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();

  const supabase = getSupabaseAdmin();
  const [state, positions, trades, tokens, wallets, performance, transactions] =
    await Promise.all([
      supabase.from("paper_state").select("*").eq("id", 1).maybeSingle(),
      supabase.from("paper_positions").select("*").order("entry_time", { ascending: false }),
      supabase.from("paper_trades").select("*").order("happened_at", { ascending: false }).limit(1000),
      supabase.from("token_scores").select("*").order("updated_at", { ascending: false }).limit(50),
      supabase.from("wallets").select("address,label,active,created_at").order("created_at"),
      supabase.from("wallet_performance").select("*").order("trust_score", { ascending: false }).limit(20),
      supabase.from("wallet_transactions").select("wallet_address,token_mint,side,sol_amount,tx_time,is_scalp").order("tx_time", { ascending: false }).limit(50),
    ]);

  const queries = { state, positions, trades, tokens, wallets, performance, transactions };
  const failed = Object.entries(queries).find(([, result]) => result.error);
  if (failed) {
    console.error(`[dashboard] ${failed[0]} query failed`, failed[1].error);
    return NextResponse.json({ error: "Dashboard data is temporarily unavailable" }, { status: 500 });
  }

  const tradeRows = trades.data ?? [];
  const grouped = new Map<string, { pnl: number; cost: number; soldPct: number }>();
  for (const row of tradeRows) {
    const key = row.position_id ?? `${row.mint}:${row.entry_price}`;
    const current = grouped.get(key) ?? { pnl: 0, cost: 0, soldPct: 0 };
    current.pnl += Number(row.pnl_sol);
    current.cost += Number(row.sold_size_sol);
    current.soldPct += Number(row.sold_pct);
    grouped.set(key, current);
  }
  // A ladder sale is not a completed trade. Count a position only after
  // all of its original size has been sold.
  const closed = [...grouped.values()].filter((item) => item.soldPct >= 0.999);
  const wins = closed.filter((item) => item.pnl > 0).length;
  const grossProfit = closed.filter((item) => item.pnl > 0).reduce((sum, item) => sum + item.pnl, 0);
  const grossLoss = Math.abs(closed.filter((item) => item.pnl < 0).reduce((sum, item) => sum + item.pnl, 0));

  // Mark every open position to its current market price. Position sizes are
  // denominated in SOL, while DexScreener prices are USD, so the price ratio
  // converts the remaining SOL cost basis into its current simulated SOL value.
  // A temporary price failure falls back to cost basis without breaking the
  // whole dashboard, and the response tells the UI that equity is estimated.
  const rawPositions = positions.data ?? [];
  const pricedPositions = await Promise.all(
    rawPositions.map(async (position) => {
      const sizeSol = Number(position.size_sol);
      const remainingPct = Number(position.remaining_pct);
      const entryPriceUsd = Number(position.entry_price);
      const remainingCostSol =
        (Number.isFinite(sizeSol) ? Math.max(0, sizeSol) : 0) *
        (Number.isFinite(remainingPct) ? Math.max(0, remainingPct) : 0);

      try {
        if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
          throw new Error(`Invalid entry price: ${position.entry_price}`);
        }

        const price = await getPriceUsd(position.mint);
        if (!Number.isFinite(price.priceUsd) || price.priceUsd <= 0) {
          throw new Error(`Invalid current price: ${price.priceUsd}`);
        }

        const currentMultiple = price.priceUsd / entryPriceUsd;
        const currentValueSol = remainingCostSol * currentMultiple;

        return {
          ...position,
          current_price_usd: price.priceUsd,
          current_multiple: currentMultiple,
          current_value_sol: currentValueSol,
          unrealized_pnl_sol: currentValueSol - remainingCostSol,
          price_status: "live",
        };
      } catch (error) {
        console.warn(
          `[dashboard] Live price unavailable for ${position.mint}:`,
          error
        );

        return {
          ...position,
          current_price_usd: null,
          current_multiple: null,
          current_value_sol: remainingCostSol,
          unrealized_pnl_sol: null,
          price_status: "unavailable",
        };
      }
    })
  );

  const cashSol = Number(state.data?.bankroll_sol ?? 0);
  const openPositionValueSol = pricedPositions.reduce(
    (sum, position) => sum + Number(position.current_value_sol),
    0
  );
  const unrealizedPnlSol = pricedPositions.reduce(
    (sum, position) => sum + Number(position.unrealized_pnl_sol ?? 0),
    0
  );
  const livePricesUnavailable = pricedPositions.filter(
    (position) => position.price_status !== "live"
  ).length;
  const liveEquitySol =
    (Number.isFinite(cashSol) ? cashSol : 0) + openPositionValueSol;

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    state: state.data,
    positions: pricedPositions,
    trades: tradeRows.slice(0, 100),
    tokens: tokens.data ?? [],
    summary: {
      completedPositions: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? wins / closed.length : 0,
      totalPnlSol: closed.reduce((sum, item) => sum + item.pnl, 0),
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      liveEquitySol,
      cashSol: Number.isFinite(cashSol) ? cashSol : 0,
      openPositionValueSol,
      unrealizedPnlSol,
      livePricesUnavailable,
      openPositions: pricedPositions.length,
      activeWallets: (wallets.data ?? []).filter((wallet) => wallet.active).length,
      configuredWallets: wallets.data?.length ?? 0,
    },
    // A viewer can follow performance without receiving the private source
    // list of complete wallet addresses.
    performance: (performance.data ?? []).map((row) => ({
      ...row,
      wallet_address: maskAddress(row.wallet_address),
    })),
    transactions: (transactions.data ?? []).map((row) => ({
      ...row,
      wallet_address: maskAddress(row.wallet_address),
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
