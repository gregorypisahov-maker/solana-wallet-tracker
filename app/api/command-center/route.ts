import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const ageMinutes = (value: string | null | undefined) => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 60_000) : null;
};

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

function decisionFor(token: any) {
  const score = Number(token.score ?? 0);
  const wallets = Number(token.wallets_count ?? 0);
  const totalBuy = Number(token.total_sol_bought ?? 0);
  const liquidity = Number(token.liquidity_usd ?? 0);
  const marketCap = Number(token.market_cap ?? 0);
  const averageBuy = wallets > 0 ? totalBuy / wallets : 0;
  const ratio = marketCap > 0 ? liquidity / marketCap : 0;
  const reasons: string[] = [];

  if (score < 10) reasons.push(`score ${score} below 10`);
  if (score > 65) reasons.push(`score ${score} above late-entry ceiling 65`);
  if (wallets < 3) reasons.push(`${wallets} wallets below 3-wallet consensus`);
  if (averageBuy < 0.75) reasons.push(`average buy ${averageBuy.toFixed(2)} SOL below 0.75`);
  if (liquidity < 15_000) reasons.push("liquidity below $15k");
  if (ratio < 0.15) reasons.push(`liquidity/market-cap ${(ratio * 100).toFixed(0)}% below 15%`);
  if (marketCap < 20_000) reasons.push("market cap below $20k");
  if (marketCap > 200_000) reasons.push("market cap above $200k");
  if (token.dump_flag) reasons.push("dump flag detected");

  return {
    token: token.token_symbol ?? "UNKNOWN",
    mint: token.token_mint,
    score,
    wallets,
    updatedAt: token.updated_at ?? token.last_buy_time,
    accepted: reasons.length === 0,
    reasons: reasons.length ? reasons : ["passes visible market and consensus safeguards"],
  };
}

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();

  const supabase = getSupabaseAdmin({ noStore: true });
  const [state, latestTransaction, latestToken, intelligence, wallets, performance, trades, tokens] =
    await Promise.all([
      supabase.from("paper_state").select("halted,halt_reason").eq("id", 1).maybeSingle(),
      supabase.from("wallet_transactions").select("tx_time").order("tx_time", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("token_scores").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("wallet_intelligence_runs").select("ran_at,promoted_count,disabled_count,notes").order("ran_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("wallets").select("address,active,management_status"),
      supabase.from("wallet_performance").select("wallet_address,completed_trades,win_rate,average_return,realized_pnl_sol,profit_factor,trust_score").order("trust_score", { ascending: false }),
      supabase.from("paper_trades").select("position_id,pnl_sol,sold_pct,happened_at,reason,token_symbol").order("happened_at", { ascending: false }).limit(500),
      supabase.from("token_scores").select("token_mint,token_symbol,score,wallets_count,total_sol_bought,market_cap,liquidity_usd,dump_flag,updated_at,last_buy_time").order("updated_at", { ascending: false }).limit(12),
    ]);

  const results = { state, latestTransaction, latestToken, intelligence, wallets, performance, trades, tokens };
  for (const [name, result] of Object.entries(results)) {
    if (result.error) console.error(`[command-center] ${name} query failed`, result.error);
  }

  const walletRows = wallets.error ? [] : wallets.data ?? [];
  const active = walletRows.filter((wallet) => wallet.active);
  const proven = active.filter((wallet) => wallet.management_status === "proven");
  const trial = active.filter((wallet) => wallet.management_status === "trial");
  const activeSet = new Set(active.map((wallet) => wallet.address));
  const ranked = (performance.error ? [] : performance.data ?? []).filter((wallet) => activeSet.has(wallet.wallet_address));

  const grouped = new Map<string, { pnl: number; soldPct: number; happenedAt: string }>();
  for (const row of trades.error ? [] : trades.data ?? []) {
    const key = row.position_id ?? `${row.token_symbol}:${row.happened_at}`;
    const current = grouped.get(key) ?? { pnl: 0, soldPct: 0, happenedAt: row.happened_at };
    current.pnl += Number(row.pnl_sol ?? 0);
    current.soldPct += Number(row.sold_pct ?? 0);
    grouped.set(key, current);
  }

  const closed = [...grouped.values()].filter((row) => row.soldPct >= 0.999);
  const recentCutoff = Date.now() - 24 * 60 * 60_000;
  const last24h = closed.filter((row) => Date.parse(row.happenedAt) >= recentCutoff);
  const pnl24h = last24h.reduce((sum, row) => sum + row.pnl, 0);
  const wins24h = last24h.filter((row) => row.pnl > 0).length;

  const best = ranked[0];
  const weakestTrial = ranked
    .filter((row) => trial.some((wallet) => wallet.address === row.wallet_address))
    .sort((a, b) => Number(a.trust_score) - Number(b.trust_score))[0];
  const decisions = (tokens.error ? [] : tokens.data ?? []).map(decisionFor);
  const rejected = decisions.filter((decision) => !decision.accepted).length;

  const coach: string[] = [];
  if (last24h.length === 0) coach.push("No completed positions in the last 24 hours; keep collecting fresh post-change evidence.");
  else coach.push(`${last24h.length} positions closed in 24h with ${wins24h} wins and ${pnl24h >= 0 ? "+" : ""}${pnl24h.toFixed(3)} SOL PnL.`);
  if (best) coach.push(`Current strongest active wallet is ${short(best.wallet_address)} at trust ${Number(best.trust_score).toFixed(0)} and PF ${best.profit_factor == null ? "n/a" : Number(best.profit_factor).toFixed(2)}.`);
  if (weakestTrial && Number(weakestTrial.completed_trades) >= 10) coach.push(`Watch trial ${short(weakestTrial.wallet_address)}: trust ${Number(weakestTrial.trust_score).toFixed(0)} after ${weakestTrial.completed_trades} matched trades.`);
  if (rejected > 0) coach.push(`${rejected} of the latest ${decisions.length} token signals fail at least one visible entry safeguard.`);
  if (state.data?.halted) coach.push(`Paper entries are halted: ${state.data.halt_reason ?? "risk limit reached"}.`);
  else coach.push("Paper trader is enabled; avoid changing thresholds until a meaningful fresh sample is complete.");

  const transactionAge = ageMinutes(latestTransaction.error ? null : latestTransaction.data?.tx_time);
  const tokenAge = ageMinutes(latestToken.error ? null : latestToken.data?.updated_at);
  const intelligenceAge = ageMinutes(intelligence.error ? null : intelligence.data?.ran_at);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    health: [
      { name: "Paper trader", ok: !state.error && !state.data?.halted, detail: state.error ? "state unavailable" : state.data?.halted ? state.data.halt_reason ?? "halted" : "enabled" },
      { name: "Wallet monitor", ok: transactionAge !== null && transactionAge < 30, detail: transactionAge == null ? "no transaction heartbeat" : `last activity ${Math.floor(transactionAge)}m ago` },
      { name: "Consensus engine", ok: tokenAge !== null && tokenAge < 30, detail: tokenAge == null ? "no score heartbeat" : `last score ${Math.floor(tokenAge)}m ago` },
      { name: "Wallet intelligence", ok: intelligenceAge !== null && intelligenceAge < 90, detail: intelligenceAge == null ? "never run" : `last run ${Math.floor(intelligenceAge)}m ago` },
      { name: "Supabase", ok: !Object.values(results).some((result) => result.error), detail: Object.values(results).some((result) => result.error) ? "some panels degraded" : "queries healthy" },
    ],
    wallets: {
      proven: proven.length,
      trial: trial.length,
      total: active.length,
      promotedLastRun: Number(intelligence.error ? 0 : intelligence.data?.promoted_count ?? 0),
      disabledLastRun: Number(intelligence.error ? 0 : intelligence.data?.disabled_count ?? 0),
      replacementsLastRun: Number(intelligence.error ? 0 : (intelligence.data as any)?.notes?.immediate_replacement?.added_count ?? 0),
      leaders: ranked.slice(0, 5).map((row) => ({ ...row, wallet_address: short(row.wallet_address) })),
    },
    decisions,
    coach,
  }, { headers: { "Cache-Control": "no-store" } });
}
