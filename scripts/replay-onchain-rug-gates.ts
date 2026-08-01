import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";
import { resolveOnchainLpSafety, resolveTokenControls } from "../live-executor/onchainRugSafety";

const supabase = getSupabaseAdmin();
const RUG_REASONS = new Set(["emergency_liquidity_drop", "liquidity_gone", "quote_unavailable_forced_exit"]);

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const { data, error } = await supabase
    .from("ai_discovery_trades")
    .select("id,mint,token_symbol,pair_address,net_return_pct,pnl_sol,exit_reason,entry_snapshot,opened_at,closed_at")
    .order("opened_at", { ascending: true });
  if (error) throw new Error(error.message);

  let catastrophes = 0;
  let catastropheBlocked = 0;
  let winners = 0;
  let winnersBlocked = 0;
  let blockedWinnerPnl = 0;
  let currentPnl = 0;
  let replayPnl = 0;
  const named: Record<string, unknown>[] = [];

  for (const trade of data ?? []) {
    const pnl = n(trade.pnl_sol);
    const net = n(trade.net_return_pct);
    currentPnl += pnl;
    const catastrophe = RUG_REASONS.has(String(trade.exit_reason)) || net <= -80;
    const winner = pnl > 0;
    if (catastrophe) catastrophes += 1;
    if (winner) winners += 1;

    const snapshot = (trade.entry_snapshot ?? {}) as Record<string, any>;
    const dexId = snapshot.dexId ?? snapshot.dex_id ?? snapshot.market?.dexId ?? null;
    const pool = String(trade.pair_address ?? snapshot.pairAddress ?? snapshot.pair_address ?? "");
    let reason: string | null = null;
    let lp: any = null;
    let controls: any = null;
    try {
      controls = await resolveTokenControls(String(trade.mint));
      if (!controls.safe) reason = controls.reason;
      if (!reason && pool) {
        lp = await resolveOnchainLpSafety({ mint: String(trade.mint), pool, dexId });
        if (lp.verdict === "UNLOCKED") reason = "liquidity_unlocked";
      }
    } catch (resolverError) {
      lp = { verdict: "UNKNOWN", error: resolverError instanceof Error ? resolverError.message : String(resolverError) };
    }

    const blocked = reason != null;
    if (!blocked) replayPnl += pnl;
    if (catastrophe && blocked) catastropheBlocked += 1;
    if (winner && blocked) { winnersBlocked += 1; blockedWinnerPnl += pnl; }
    if (/^(papoi|grok|pipedog)$/i.test(String(trade.token_symbol))) {
      named.push({ id: trade.id, symbol: trade.token_symbol, mint: trade.mint, netReturnPct: net, reason, controls, lp });
    }
  }

  const catchRate = catastrophes ? catastropheBlocked / catastrophes : 0;
  const report = {
    totalTrades: data?.length ?? 0,
    catastrophes,
    catastropheBlocked,
    catchRatePct: catchRate * 100,
    winners,
    winnersBlocked,
    blockedWinnerPnlSol: blockedWinnerPnl,
    currentPnlSol: currentPnl,
    replayPnlSol: replayPnl,
    netEffectSol: replayPnl - currentPnl,
    namedAcceptance: named,
    goNoGo: catastrophes > 0 && catastropheBlocked === catastrophes && named.every((row: any) => row.reason) ? "GO" : "NO_GO",
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.goNoGo !== "GO") process.exitCode = 2;
}

main().catch((error) => {
  console.error("[onchain-rug-replay] failed", error);
  process.exit(1);
});
