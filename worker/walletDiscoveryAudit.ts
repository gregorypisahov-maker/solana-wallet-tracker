import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";
import { discoverTrialWallets } from "./walletDiscovery";

const supabase = getSupabaseAdmin();

const configuredIntervalHours = Number(
  process.env.WALLET_DISCOVERY_INTERVAL_HOURS ?? 6
);
const INTERVAL_HOURS = Number.isFinite(configuredIntervalHours)
  ? Math.max(1, Math.min(24, configuredIntervalHours))
  : 6;
const DISCOVERY_SOURCE = "helius_seed_token_cotrader";
const ENDPOINT = "helius://seed-token-cotrader";

let running = false;

async function recordRun(input: {
  status: "success" | "no_candidates" | "no_slots" | "error";
  fetched?: number;
  eligible?: number;
  added?: string[];
  errorMessage?: string;
}): Promise<void> {
  const { error } = await supabase.from("wallet_discovery_runs").insert({
    source: DISCOVERY_SOURCE,
    status: input.status,
    fetched_count: input.fetched ?? 0,
    eligible_count: input.eligible ?? 0,
    added_count: input.added?.length ?? 0,
    added_addresses: input.added ?? [],
    error_message: input.errorMessage ?? null,
    endpoint: ENDPOINT,
    ran_at: new Date().toISOString(),
  });

  if (error) {
    console.error("[wallet-discovery] failed to save run audit:", error);
  }
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const result = await discoverTrialWallets();
    const status =
      result.added.length > 0
        ? "success"
        : result.eligible === 0
          ? "no_candidates"
          : "no_slots";

    await recordRun({
      status,
      fetched: result.fetched,
      eligible: result.eligible,
      added: result.added,
    });

    console.log(
      `[wallet-discovery-audit] ${status}; fetched=${result.fetched}; ` +
        `eligible=${result.eligible}; added=${result.added.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRun({ status: "error", errorMessage: message });
    console.error(`[wallet-discovery-audit] error: ${message}`);
  } finally {
    running = false;
  }
}

export function startAuditedWalletDiscoveryScheduler(): void {
  void runOnce();
  setInterval(() => void runOnce(), INTERVAL_HOURS * 3_600_000);
  console.log(
    `[wallet-discovery-audit] enabled every ${INTERVAL_HOURS}h with persistent run logging; ` +
      "initial run started"
  );
}
