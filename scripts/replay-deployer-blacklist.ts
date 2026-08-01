import { getSupabaseAdmin } from "../lib/supabase";

const RUG_REASONS = new Set(["emergency_liquidity_drop", "liquidity_gone", "quote_unavailable_forced_exit"]);
const isRug = (t: any) => RUG_REASONS.has(String(t.exit_reason)) || Number(t.net_return_pct) <= -80;

async function main() {
  const supabase = getSupabaseAdmin();
  const { data: trades, error } = await supabase.from("ai_discovery_trades").select("id,mint,token_symbol,opened_at,closed_at,exit_reason,net_return_pct,pnl_sol").order("opened_at");
  if (error) throw new Error(error.message);
  const mints = [...new Set((trades ?? []).map((t: any) => t.mint))];
  const { data: cache, error: cacheError } = await supabase.from("deployer_by_mint").select("mint,deployer").in("mint", mints);
  if (cacheError) throw new Error(cacheError.message);
  const deployerFor = new Map((cache ?? []).map((r: any) => [r.mint, r.deployer]));
  const priorRugClose = new Map<string, number>();
  let totalRugs = 0, caughtRugs = 0, blockedWinners = 0, blockedWinnerPnl = 0, blockedPnl = 0, currentPnl = 0;
  for (const trade of trades ?? []) {
    const deployer = deployerFor.get(trade.mint);
    const opened = Date.parse(trade.opened_at);
    const blacklisted = Boolean(deployer && (priorRugClose.get(deployer) ?? Infinity) < opened);
    const rug = isRug(trade);
    const pnl = Number(trade.pnl_sol ?? 0);
    currentPnl += pnl;
    if (rug) { totalRugs += 1; if (blacklisted) caughtRugs += 1; }
    if (blacklisted) {
      blockedPnl += pnl;
      if (pnl > 0) { blockedWinners += 1; blockedWinnerPnl += pnl; }
    }
    if (rug && deployer && trade.closed_at) {
      const closed = Date.parse(trade.closed_at);
      priorRugClose.set(deployer, Math.min(priorRugClose.get(deployer) ?? Infinity, closed));
    }
  }
  const replayPnl = currentPnl - blockedPnl;
  console.log(JSON.stringify({ trades: trades?.length ?? 0, resolvedMints: cache?.filter((x: any) => x.deployer).length ?? 0, totalRugs, caughtRugs, catchRatePct: totalRugs ? caughtRugs / totalRugs * 100 : 0, blockedWinners, falsePositiveWinnerPnlSol: blockedWinnerPnl, currentPnlSol: currentPnl, blockedTradesNetPnlSol: blockedPnl, replayPnlSol: replayPnl, netEffectSol: replayPnl - currentPnl }, null, 2));
}
main().catch((error) => { console.error(error); process.exit(1); });
