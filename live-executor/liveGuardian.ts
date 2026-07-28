import { getSupabaseAdmin } from "../lib/supabase";
import {
  getLiveWalletHealth,
  getWalletTokenRawAmount,
} from "../lib/liveWallet";

const supabase = getSupabaseAdmin();
const DEFAULT_MAX_CONSECUTIVE_LOSSES = 3;
const DEFAULT_MAX_HOT_WALLET_SOL = 0.25;
const LOSS_STREAK_HALT_ENABLED = process.env.LIVE_LOSS_STREAK_HALT_ENABLED === "true";

const n = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function halt(reason: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("live_executor_state")
    .update({
      enabled: false,
      halted: true,
      halt_reason: reason,
      updated_at: now,
    })
    .eq("id", 1);
  if (error) throw new Error(error.message);
}

async function reconcileOpenPositionsOnBoot(): Promise<void> {
  const { data: positions, error } = await supabase
    .from("live_positions")
    .select("id,mint,token_amount,status")
    .in("status", ["open", "closing", "reconciliation_required"]);
  if (error) throw new Error(error.message);

  for (const position of positions ?? []) {
    if (position.status !== "open") {
      await halt(`boot_reconciliation_required:${position.id}`);
      throw new Error(`boot_reconciliation_required:${position.id}`);
    }

    const walletAmount = await getWalletTokenRawAmount(String(position.mint));
    const storedAmount = BigInt(String(position.token_amount ?? "0"));
    if (storedAmount <= 0n || walletAmount < storedAmount) {
      await supabase
        .from("live_positions")
        .update({
          status: "reconciliation_required",
          updated_at: new Date().toISOString(),
        })
        .eq("id", position.id);
      await halt(`boot_position_balance_mismatch:${position.id}`);
      throw new Error(`boot_position_balance_mismatch:${position.id}`);
    }
  }

  const { error: updateError } = await supabase
    .from("live_executor_state")
    .update({
      boot_reconciled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (updateError) throw new Error(updateError.message);
}

async function enforceHotWalletLimit(): Promise<void> {
  const health = await getLiveWalletHealth();
  if (!health.publicKey || !health.signerConfigured || !health.rpcConfigured || health.error) {
    await halt("guardian_wallet_health_failed");
    throw new Error("guardian_wallet_health_failed");
  }

  const maxHotWalletSol = Math.max(
    0.05,
    Number(process.env.LIVE_MAX_HOT_WALLET_SOL) || DEFAULT_MAX_HOT_WALLET_SOL
  );
  if (health.balanceSol != null && health.balanceSol > maxHotWalletSol) {
    await halt(`hot_wallet_limit_exceeded:${health.balanceSol.toFixed(6)}>${maxHotWalletSol.toFixed(6)}`);
    throw new Error("hot_wallet_limit_exceeded");
  }
}

async function calculateConsecutiveLosses(): Promise<number> {
  const { data, error } = await supabase
    .from("live_positions")
    .select("realized_pnl_sol,closed_at")
    .eq("status", "closed")
    .not("realized_pnl_sol", "is", null)
    .order("closed_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);

  let streak = 0;
  for (const row of data ?? []) {
    if (n(row.realized_pnl_sol) < 0) streak += 1;
    else break;
  }
  return streak;
}

export async function runLiveGuardian(): Promise<void> {
  await reconcileOpenPositionsOnBoot();
  await enforceHotWalletLimit();
  await checkLiveLossStreak();
}

export async function checkLiveLossStreak(): Promise<void> {
  const consecutiveLosses = await calculateConsecutiveLosses();
  const { data: state, error } = await supabase
    .from("live_executor_state")
    .select("max_consecutive_losses")
    .eq("id", 1)
    .single();
  if (error) throw new Error(error.message);

  const maxLosses = Math.max(
    1,
    n(state?.max_consecutive_losses, DEFAULT_MAX_CONSECUTIVE_LOSSES)
  );
  const thresholdReached = consecutiveLosses >= maxLosses;
  const shouldHalt = LOSS_STREAK_HALT_ENABLED && thresholdReached;

  if (thresholdReached && !LOSS_STREAK_HALT_ENABLED) {
    console.warn(
      `[live-guardian] consecutive loss warning: ${consecutiveLosses} losses (halt disabled)`
    );
  }

  const { error: updateError } = await supabase
    .from("live_executor_state")
    .update({
      consecutive_losses: consecutiveLosses,
      ...(shouldHalt
        ? {
            enabled: false,
            halted: true,
            halt_reason: `consecutive_live_losses:${consecutiveLosses}`,
          }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (updateError) throw new Error(updateError.message);
}

export function startLiveGuardianMonitor(): void {
  setInterval(
    () =>
      void checkLiveLossStreak().catch((error) =>
        console.error("[live-guardian] loss-streak check failed", error)
      ),
    10_000
  );
}
