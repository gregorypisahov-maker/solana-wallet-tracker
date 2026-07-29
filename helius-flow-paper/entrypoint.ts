import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";
import { flowPaperConfig as config } from "./config";

const supabase = getSupabaseAdmin();
const LAMPORTS_PER_SOL = 1_000_000_000;
let entryRunning = false;
let positionRunning = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const solToLamports = (sol: number) => String(Math.floor(sol * LAMPORTS_PER_SOL));
const lamportsToSol = (lamports: bigint) => Number(lamports) / LAMPORTS_PER_SOL;
const normalizeSymbol = (symbol: unknown) => String(symbol || "").trim().toLowerCase();

async function state() {
  const { data, error } = await supabase.from("helius_flow_paper_state").select("*").eq("service", config.service).single();
  if (error) throw error;
  return data as any;
}

async function openPositions() {
  const { data, error } = await supabase.from("helius_flow_paper_positions").select("*").order("opened_at");
  if (error) throw error;
  return (data || []) as any[];
}

async function recentlyTraded(mint: string) {
  const cutoff = new Date(Date.now() - config.cooldownMinutes * 60_000).toISOString();
  const { data } = await supabase.from("helius_flow_paper_trades").select("id").eq("mint", mint).gte("closed_at", cutoff).limit(1);
  return Boolean(data?.length);
}

async function symbolRugBlocked(symbol: unknown) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  const { data, error } = await supabase.from("ai_symbol_rug_cooldown_blocks")
    .select("id").eq("normalized_symbol", normalized).gt("cooldown_until", new Date().toISOString()).limit(1);
  if (error) {
    if (String((error as any)?.code || "") === "42P01") return false;
    throw error;
  }
  return Boolean(data?.length);
}

async function nextCandidate() {
  const cutoff = new Date(Date.now() - config.snapshotMaxAgeSeconds * 1000).toISOString();
  const { data, error } = await supabase.from("token_intelligence_snapshots")
    .select("id,mint,symbol,pair_address,observed_at,recommendation,snapshot")
    .eq("recommendation", "would_consider")
    .gte("observed_at", cutoff)
    .order("observed_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  for (const row of data || []) {
    const snap = (row as any).snapshot || {};
    if (Number(snap.source_score || 0) < config.minimumSourceScore) continue;
    if (snap.trade_eligible !== true) continue;
    if (snap.signal_version !== "helius_flow_signal_v1") continue;
    if (await symbolRugBlocked((row as any).symbol)) continue;
    if (await recentlyTraded((row as any).mint)) continue;
    return row as any;
  }
  return null;
}

async function enterCycle() {
  if (entryRunning || !config.enabled) return;
  entryRunning = true;
  try {
    const s = await state();
    if (!s.enabled) return;
    const positions = await openPositions();
    if (positions.length >= config.maxOpenPositions) return;
    if (Number(s.cash_sol) < config.positionSizeSol) return;

    const candidate = await nextCandidate();
    if (!candidate || positions.some((p) => p.mint === candidate.mint)) return;

    const buy = await getJupiterQuote({
      inputMint: JUPITER_SOL_MINT,
      outputMint: candidate.mint,
      rawTokenAmount: solToLamports(config.positionSizeSol),
      slippageBps: config.slippageBps,
    });
    if (!buy.route || buy.outLamports <= 0n) return;

    const sellCheck = await getJupiterQuote({
      inputMint: candidate.mint,
      outputMint: JUPITER_SOL_MINT,
      rawTokenAmount: buy.outLamports.toString(),
      slippageBps: config.slippageBps,
    });
    if (!sellCheck.route || sellCheck.outLamports <= 0n) return;

    const executableSol = lamportsToSol(sellCheck.outLamports);
    const positionId = randomUUID();
    const entrySnapshot = {
      intelligence_snapshot_id: candidate.id,
      intelligence: candidate.snapshot,
      buy_quote: buy.raw,
      immediate_sell_quote: sellCheck.raw,
      immediate_round_trip_sol: executableSol,
      paper_only: true,
    };

    const { error: positionError } = await supabase.from("helius_flow_paper_positions").insert({
      position_id: positionId,
      mint: candidate.mint,
      symbol: candidate.symbol,
      pair_address: candidate.pair_address,
      intelligence_snapshot_id: candidate.id,
      size_sol: config.positionSizeSol,
      token_raw_amount: buy.outLamports.toString(),
      entry_value_lamports: solToLamports(config.positionSizeSol),
      peak_executable_sol: executableSol,
      last_executable_sol: executableSol,
      quote_fail_streak: 0,
      entry_snapshot: entrySnapshot,
    });
    if (positionError) throw positionError;

    const { error: stateError } = await supabase.from("helius_flow_paper_state").update({
      cash_sol: Number(s.cash_sol) - config.positionSizeSol,
      updated_at: new Date().toISOString(),
    }).eq("service", config.service);
    if (stateError) {
      await supabase.from("helius_flow_paper_positions").delete().eq("position_id", positionId);
      throw stateError;
    }
    console.log(`[helius-flow-paper] opened ${candidate.symbol || candidate.mint} size=${config.positionSizeSol} SOL`);
  } catch (error) {
    console.error("[helius-flow-paper] entry cycle failed", error);
  } finally {
    entryRunning = false;
  }
}

function exitReason(position: any, executableSol: number) {
  const size = Number(position.size_sol);
  const returnPct = ((executableSol / size) - 1) * 100;
  const peak = Math.max(Number(position.peak_executable_sol || 0), executableSol);
  const trailPct = peak > 0 ? ((executableSol / peak) - 1) * 100 : 0;
  const ageMs = Date.now() - new Date(position.opened_at).getTime();
  if (returnPct <= config.hardStopPct) return "hard_stop";
  if (returnPct >= config.takeProfitPct) return "take_profit";
  if (((peak / size) - 1) * 100 >= config.trailArmPct && trailPct <= -config.trailDistancePct) return "trailing_stop";
  if (ageMs >= config.maxHoldMinutes * 60_000) return "max_hold";
  return null;
}

async function closePosition(position: any, proceedsSol: number, reason: string, quote: any) {
  const s = await state();
  const pnlSol = proceedsSol - Number(position.size_sol);
  const returnPct = (pnlSol / Number(position.size_sol)) * 100;
  const closedAt = new Date().toISOString();

  const { error: tradeError } = await supabase.from("helius_flow_paper_trades").insert({
    position_id: position.position_id,
    mint: position.mint,
    symbol: position.symbol,
    pair_address: position.pair_address,
    intelligence_snapshot_id: position.intelligence_snapshot_id,
    size_sol: position.size_sol,
    proceeds_sol: proceedsSol,
    pnl_sol: pnlSol,
    net_return_pct: returnPct,
    exit_reason: reason,
    opened_at: position.opened_at,
    closed_at: closedAt,
    entry_snapshot: position.entry_snapshot,
    exit_snapshot: { quote, executable_sol: proceedsSol, paper_only: true },
  });
  if (tradeError) throw tradeError;

  const { error: deleteError } = await supabase.from("helius_flow_paper_positions").delete().eq("position_id", position.position_id);
  if (deleteError) throw deleteError;

  const { error: stateError } = await supabase.from("helius_flow_paper_state").update({
    cash_sol: Number(s.cash_sol) + proceedsSol,
    realized_pnl_sol: Number(s.realized_pnl_sol) + pnlSol,
    updated_at: closedAt,
  }).eq("service", config.service);
  if (stateError) throw stateError;
  console.log(`[helius-flow-paper] closed ${position.symbol || position.mint} ${reason} pnl=${pnlSol.toFixed(5)} SOL`);
}

async function registerQuoteFailure(position: any, failure: string) {
  const nextStreak = Number(position.quote_fail_streak || 0) + 1;
  if (nextStreak >= config.maxQuoteFailStreak) {
    await closePosition(position, 0, "liquidity_gone", {
      route: false,
      failure,
      quote_fail_streak: nextStreak,
      policy: "honest_total_loss_after_consecutive_no_route",
    });
    return;
  }
  await supabase.from("helius_flow_paper_positions").update({
    quote_fail_streak: nextStreak,
    first_quote_fail_at: position.first_quote_fail_at || new Date().toISOString(),
    last_quote_failure: failure,
    last_checked_at: new Date().toISOString(),
  }).eq("position_id", position.position_id);
}

async function manageCycle() {
  if (positionRunning || !config.enabled) return;
  positionRunning = true;
  try {
    for (const position of await openPositions()) {
      try {
        const sell = await getJupiterQuote({
          inputMint: position.mint,
          outputMint: JUPITER_SOL_MINT,
          rawTokenAmount: position.token_raw_amount,
          slippageBps: config.slippageBps,
        });
        if (!sell.route || sell.outLamports <= 0n) {
          await registerQuoteFailure(position, "no_sell_route");
          continue;
        }
        const executableSol = lamportsToSol(sell.outLamports);
        const peak = Math.max(Number(position.peak_executable_sol || 0), executableSol);
        const reason = exitReason({ ...position, peak_executable_sol: peak }, executableSol);
        if (reason) await closePosition(position, executableSol, reason, sell.raw);
        else await supabase.from("helius_flow_paper_positions").update({
          peak_executable_sol: peak,
          last_executable_sol: executableSol,
          quote_fail_streak: 0,
          first_quote_fail_at: null,
          last_quote_failure: null,
          last_checked_at: new Date().toISOString(),
        }).eq("position_id", position.position_id);
      } catch (error) {
        console.error("[helius-flow-paper] position check failed", position.mint, error);
        await registerQuoteFailure(position, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    console.error("[helius-flow-paper] manage cycle failed", error);
  } finally {
    positionRunning = false;
  }
}

async function main() {
  console.log(`[helius-flow-paper] starting enabled=${config.enabled} PAPER ONLY`);
  if (!config.enabled) console.warn("[helius-flow-paper] disabled; set HELIUS_FLOW_PAPER_ENABLED=true to run");
  let lastPositionCheck = 0;
  while (true) {
    await enterCycle();
    if (Date.now() - lastPositionCheck >= config.positionCheckMs) {
      await manageCycle();
      lastPositionCheck = Date.now();
    }
    await sleep(config.pollMs);
  }
}

main().catch((error) => { console.error("[helius-flow-paper] fatal", error); process.exit(1); });
