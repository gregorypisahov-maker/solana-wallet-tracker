import { getSupabaseAdmin } from "../lib/supabase";
import { config } from "./config";
import { applyExitFriction } from "./executionFriction";
import { getPriceUsd } from "./priceFeed";
import { evaluateSharedPaperExit } from "./sharedPaperExit";

const supabase = getSupabaseAdmin();
const POSITION_INTERVAL_MS = config.polling.intervalMs;
const SUSPECT_DROP_PCT = 90;
const SUSPECT_CONFIRMATION_MS = 10_000;

let checking = false;
const suspectPrices = new Map<string, { firstSeenAt: number; price: number }>();

function numberValue(value: unknown, fallback = Number.NaN): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function priceIsSuspect(positionId: string, entryPrice: number, price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return true;
  const dropPct = (1 - price / entryPrice) * 100;
  if (dropPct <= SUSPECT_DROP_PCT) {
    suspectPrices.delete(positionId);
    return false;
  }

  const now = Date.now();
  const previous = suspectPrices.get(positionId);
  if (!previous || now - previous.firstSeenAt < SUSPECT_CONFIRMATION_MS) {
    if (!previous) suspectPrices.set(positionId, { firstSeenAt: now, price });
    console.warn(`[tiered-exit] price_fetch_suspect ${positionId} drop ${dropPct.toFixed(2)}%`);
    return true;
  }

  suspectPrices.delete(positionId);
  return false;
}

async function checkTieredPositions(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const { data: positions, error } = await supabase
      .from("tiered_positions")
      .select("*")
      .order("entry_time", { ascending: true });
    if (error) throw new Error(`tiered position load failed: ${error.message}`);

    for (const position of positions ?? []) {
      try {
        const raw = await getPriceUsd(position.mint);
        const rawPrice = numberValue(raw.priceUsd);
        const entryPrice = numberValue(position.entry_price);
        if (priceIsSuspect(position.position_id, entryPrice, rawPrice)) continue;

        const exitPrice = applyExitFriction(rawPrice, config.execution.exitFrictionPct);
        if (!Number.isFinite(exitPrice) || exitPrice <= 0) continue;

        const ladderHits = Array.isArray(position.ladder_hits)
          ? position.ladder_hits.map(Number)
          : [];
        const decision = evaluateSharedPaperExit({
          entryPrice,
          entryTime: Date.parse(position.entry_time),
          remainingPct: numberValue(position.remaining_pct, 1),
          peakMultiple: numberValue(position.peak_multiple, 1),
          ladderHits,
        }, exitPrice);

        if (decision.actions.length === 0) {
          const { error: peakError } = await supabase.rpc("tiered_record_peak", {
            p_position_id: position.position_id,
            p_peak_multiple: decision.peakMultiple,
          });
          if (peakError) throw new Error(`tiered peak update failed: ${peakError.message}`);
          continue;
        }

        const updatedHits = [...ladderHits];
        for (const action of decision.actions) {
          const rung = /^ladder_(.+)x$/.exec(action.reason);
          if (rung) updatedHits.push(Number(rung[1]));

          const { data: result, error: exitError } = await supabase.rpc("tiered_apply_exit", {
            p_position_id: position.position_id,
            p_exit_price: exitPrice,
            p_requested_sold_pct: action.soldPct,
            p_reason: action.reason,
            p_action_terminal: action.terminal,
            p_peak_multiple: decision.peakMultiple,
            p_ladder_hits: updatedHits,
          });
          if (exitError) throw new Error(`tiered atomic exit failed: ${exitError.message}`);
          if (!result?.applied) {
            if (result?.reason === "position_not_found") break;
            throw new Error(`tiered atomic exit rejected: ${result?.reason ?? "unknown"}`);
          }

          console.log(
            `[tiered-exit] ${position.token_symbol} ${action.reason} ` +
            `${Number(result.pnl_sol) >= 0 ? "+" : ""}${Number(result.pnl_sol).toFixed(4)} SOL`
          );
          if (result.halted) {
            console.warn(`[tiered-exit] entries halted: ${result.halt_reason ?? "unknown"}`);
          }
          if (result.terminal) break;
        }
      } catch (positionError) {
        console.error(`[tiered-exit] isolated position failure ${position.token_symbol}:`, positionError);
      }
    }
  } catch (error) {
    console.error("[tiered-exit] isolated position loop failed:", error);
  } finally {
    checking = false;
  }
}

export function startTieredEntryShadowScheduler(): void {
  console.log("tiered position manager active; recent signal pump exclusively owns entries");
  void checkTieredPositions();
  setInterval(() => void checkTieredPositions(), POSITION_INTERVAL_MS);
}
