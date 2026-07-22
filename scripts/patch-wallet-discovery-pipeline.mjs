import { readFileSync, writeFileSync } from "node:fs";

const path = "worker/walletDiscovery.ts";
let source = readFileSync(path, "utf8");

function replaceExact(before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`[wallet-discovery-patch] ${label} target not found`);
  }
  source = source.replace(before, after);
}

replaceExact(
  `const PROFILE_MAX_SWAPS = 50;
const PROFILE_LOOKBACK_DAYS = 14;
const PROFILE_CACHE_DAYS = 7;
const MIN_OBSERVED_SWAPS = 15;
const MIN_MEDIAN_ENTRY_DELAY_MIN = 60;
const TRIAL_MIN_MEDIAN_ENTRY_DELAY_MIN = 120;
const MAX_PCT_BUYS_UNDER_30_MIN = 0.5;
const MAX_SWAP_FREQUENCY_PER_DAY = 200;
const CHURN_PROFILE_VERSION = 3;
const MAX_DISTINCT_TOKEN_CREATION_LOOKUPS = 24;
const MAX_CANDIDATES_TO_PROFILE = 12;`,
  `// Churn must remain based on the real timestamp span of the latest 50 swaps.
const PROFILE_MAX_SWAPS = 50;
// Profitability needs a deeper sample so good wallets are not rejected only because
// the latest 50 swaps contain too few matched round trips.
const PROVEN_PROFILE_MAX_SWAPS = 100;
const PROFILE_LOOKBACK_DAYS = 14;
const PROFILE_CACHE_DAYS = 7;
const MIN_OBSERVED_SWAPS = 15;
const MIN_PROFILED_BUYS = 8;
// Known profitable wallets enter roughly 385-673 minutes after launch. A four-hour
// floor blocks launch snipers while preserving that observed winner band.
const MIN_MEDIAN_ENTRY_DELAY_MIN = 240;
const TRIAL_MIN_MEDIAN_ENTRY_DELAY_MIN = 240;
const MAX_PCT_BUYS_UNDER_30_MIN = 0.25;
// Keep the validated churn guard: hundreds of swaps/day are bot-like losers.
const MAX_SWAP_FREQUENCY_PER_DAY = 200;
const CHURN_PROFILE_VERSION = 4;
const MAX_DISTINCT_TOKEN_CREATION_LOOKUPS = 24;
// Recent data showed a sub-1% full-pipeline pass rate. Profile enough candidates per
// run to fill two open roster slots without weakening quality gates.
const MAX_CANDIDATES_TO_PROFILE = 36;`,
  "policy constants"
);

replaceExact(
  `interface ExistingWalletProfile {
  address: string;
  management_status: string | null;
  discovery_metrics: unknown;
}`,
  `interface ExistingWalletProfile {
  address: string;
  management_status: string | null;
  auto_disable_reason?: string | null;
  discovery_metrics: unknown;
}`,
  "existing wallet profile shape"
);

replaceExact(
  `function shouldSkipProfile(row: ExistingWalletProfile | undefined, force: boolean): boolean {
  if (force || !row) return false;
  return row.management_status === "disabled" || hasFreshCompletedProfile(row.discovery_metrics);
}`,
  `function shouldSkipProfile(row: ExistingWalletProfile | undefined, force: boolean): boolean {
  if (force || !row) return false;
  const metrics = (row.discovery_metrics ?? {}) as Record<string, unknown>;
  const technicalRetry =
    metrics.profile_pending_retry === true ||
    String(row.auto_disable_reason ?? "").startsWith("retroactive_profile_error:");
  if (technicalRetry) return false;
  if (row.management_status === "disabled") return true;
  return hasFreshCompletedProfile(row.discovery_metrics);
}`,
  "technical retry skip policy"
);

replaceExact(
  '`?api-key=${encodeURIComponent(apiKey)}&type=SWAP&limit=${PROFILE_MAX_SWAPS}` +',
  '`?api-key=${encodeURIComponent(apiKey)}&type=SWAP&limit=${PROVEN_PROFILE_MAX_SWAPS}` +',
  "deeper proven-trader sample"
);

replaceExact(
  `function timingRejectionReasons(profile: EntryTimingProfile): string[] {
  const reasons: string[] = [];
  if (profile.observedSwapCount < MIN_OBSERVED_SWAPS) {
    reasons.push(\`insufficient_observed_swaps:${'${profile.observedSwapCount}'}<${'${MIN_OBSERVED_SWAPS}'}\`);
  }
  if (profile.medianEntryDelayMin == null) {
    reasons.push("missing_entry_timing_data");
  } else if (profile.medianEntryDelayMin < MIN_MEDIAN_ENTRY_DELAY_MIN) {
    reasons.push(\`median_entry_delay_too_low:${'${profile.medianEntryDelayMin.toFixed(2)}'}<60\`);
  }
  if (profile.pctBuysUnder30Min == null) {
    reasons.push("missing_under_30m_share");
  } else if (profile.pctBuysUnder30Min > MAX_PCT_BUYS_UNDER_30_MIN) {
    reasons.push(\`launch_sniper_share_too_high:${'${profile.pctBuysUnder30Min.toFixed(4)}'}>0.5\`);
  }
  if (profile.swapFrequencyPerDay > MAX_SWAP_FREQUENCY_PER_DAY) {
    reasons.push("churn_above_200_per_day");
  }
  return reasons;
}`,
  `function timingRejectionReasons(profile: EntryTimingProfile): string[] {
  const reasons: string[] = [];
  if (profile.observedSwapCount < MIN_OBSERVED_SWAPS) {
    reasons.push(\`insufficient_observed_swaps:${'${profile.observedSwapCount}'}<${'${MIN_OBSERVED_SWAPS}'}\`);
  }
  if (profile.profiledBuyCount < MIN_PROFILED_BUYS) {
    reasons.push(\`insufficient_profiled_buys:${'${profile.profiledBuyCount}'}<${'${MIN_PROFILED_BUYS}'}\`);
  }
  if (profile.medianEntryDelayMin == null) {
    reasons.push("missing_entry_timing_data");
  } else if (profile.medianEntryDelayMin < MIN_MEDIAN_ENTRY_DELAY_MIN) {
    reasons.push(
      \`median_entry_delay_too_low:${'${profile.medianEntryDelayMin.toFixed(2)}'}<${'${MIN_MEDIAN_ENTRY_DELAY_MIN}'}\`
    );
  }
  if (profile.pctBuysUnder30Min == null) {
    reasons.push("missing_under_30m_share");
  } else if (profile.pctBuysUnder30Min > MAX_PCT_BUYS_UNDER_30_MIN) {
    reasons.push(
      \`launch_sniper_share_too_high:${'${profile.pctBuysUnder30Min.toFixed(4)}'}>${'${MAX_PCT_BUYS_UNDER_30_MIN}'}\`
    );
  }
  if (profile.swapFrequencyPerDay > MAX_SWAP_FREQUENCY_PER_DAY) {
    reasons.push("churn_above_200_per_day");
  }
  return reasons;
}`,
  "calibrated timing gates"
);

replaceExact(
  `if (medianDelay >= 120 && medianDelay <= 720) score += 600;`,
  `if (medianDelay >= MIN_MEDIAN_ENTRY_DELAY_MIN && medianDelay <= 720) score += 600;`,
  "winner-band scoring"
);

replaceExact(
  `    churn_profile_version: CHURN_PROFILE_VERSION,
    unprofiled_reason_counts: profile.unprofiledReasonCounts,`,
  `    churn_profile_version: CHURN_PROFILE_VERSION,
    discovery_policy_version: 4,
    unprofiled_reason_counts: profile.unprofiledReasonCounts,`,
  "policy version metric"
);

replaceExact(
  `.select("address, management_status, discovery_metrics")`,
  `.select("address, management_status, auto_disable_reason, discovery_metrics")`,
  "load technical disable reason"
);

replaceExact(
  `    } catch (error) {
      console.warn(\`[wallet-discovery] candidate profile failed ${'${candidate.address}'}:\`, error);
    }`,
  `    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /HTTP (429|5\d\d)|timed out/i.test(message);
      await logDiscoveryRejection(
        candidate.address,
        "candidate",
        [retryable ? "technical_profile_retry" : \`profile_error:${'${message}'}\`],
        {
          seed_token_count: candidate.tokenCount,
          seed_score_total: candidate.seedScoreTotal,
          max_seed_score: candidate.maxSeedScore,
          seed_tokens: candidate.seedTokens,
          profile_pending_retry: retryable,
          profile_retry_error: message,
          profile_retry_marked_at: new Date().toISOString(),
          discovery_policy_version: 4,
        }
      );
      console.warn(
        \`[wallet-discovery] candidate profile failed ${'${candidate.address}'} retryable=${'${retryable}'}:\`,
        error
      );
    }`,
  "technical candidate failure logging"
);

source = source
  .replaceAll(
    `trial_median_entry_delay_too_low:${'${profile.medianEntryDelayMin.toFixed(2)}'}<120`,
    `trial_median_entry_delay_too_low:${'${profile.medianEntryDelayMin.toFixed(2)}'}<${'${TRIAL_MIN_MEDIAN_ENTRY_DELAY_MIN}'}`
  )
  .replaceAll(
    `trial_median_entry_delay_too_low:${'${candidate.profile.medianEntryDelayMin.toFixed(2)}'}<120`,
    `trial_median_entry_delay_too_low:${'${candidate.profile.medianEntryDelayMin.toFixed(2)}'}<${'${TRIAL_MIN_MEDIAN_ENTRY_DELAY_MIN}'}`
  );

writeFileSync(path, source);
console.log(
  "[startup-patch] Wallet discovery restored with 240m delay, 25% launch-buy cap, 200/day churn cap, 8 profiled buys, 100-swap profit sample, and 36 candidates/run."
);
