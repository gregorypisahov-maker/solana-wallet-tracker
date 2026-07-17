import {
  evaluateScalpCandidate,
  evaluateScalpConfirmation,
} from "./momentumScalperRules";
import { evaluateMomentumPullback } from "./momentumPullback";
import type {
  CandidateEvaluation,
  ConfirmationEvaluation,
  FilterCheck,
  ScalpCandidate,
  ScalpMarketConfirmation,
} from "./momentumScalperRules";
import type { MinuteCandle, PullbackEvaluation } from "./momentumPullback";

export type ScalpEntryDecision = {
  accepted: boolean;
  selectedMint: string;
  candidate: Readonly<ScalpCandidate>;
  discovery: CandidateEvaluation;
  market: Readonly<ScalpMarketConfirmation>;
  confirmation: ConfirmationEvaluation;
  pullback: PullbackEvaluation;
  bindingChecks: FilterCheck[];
  pullbackSource: {
    pairAddress: string;
    candleTimestampsSeconds: number[];
  };
  reasons: string[];
};

export function buildScalpEntryDecision(input: {
  candidate: ScalpCandidate;
  market: ScalpMarketConfirmation;
  minuteCandles: MinuteCandle[];
  pullbackPairAddress: string;
  nowMs?: number;
}): ScalpEntryDecision {
  const candidate = Object.freeze({ ...input.candidate });
  const market = Object.freeze({ ...input.market });
  const discovery = evaluateScalpCandidate(candidate);
  const confirmation = evaluateScalpConfirmation(candidate, market);
  const pullback = evaluateMomentumPullback(input.minuteCandles, input.nowMs);
  const bindingChecks: FilterCheck[] = [
    {
      name: "selected_mint_matches_all_snapshots",
      passed: candidate.mint.length > 0 && candidate.mint === market.mint,
      actual: market.mint || null,
      expected: candidate.mint || "selected candidate mint",
      reason:
        candidate.mint.length > 0 && candidate.mint === market.mint
          ? null
          : "selected_snapshot_mint_mismatch",
    },
    {
      name: "pullback_pair_matches_selected_candidate",
      passed:
        candidate.pairAddress.length > 0 &&
        candidate.pairAddress === input.pullbackPairAddress,
      actual: input.pullbackPairAddress || null,
      expected: candidate.pairAddress || "selected candidate pair",
      reason:
        candidate.pairAddress.length > 0 &&
        candidate.pairAddress === input.pullbackPairAddress
          ? null
          : "pullback_pair_mismatch",
    },
  ];
  const reasons = [
    ...discovery.reasons,
    ...confirmation.reasons,
    ...pullback.reasons,
    ...bindingChecks.flatMap((check) => check.reason ? [check.reason] : []),
  ];

  return {
    accepted:
      discovery.accepted &&
      confirmation.accepted &&
      pullback.accepted &&
      bindingChecks.every((check) => check.passed),
    selectedMint: candidate.mint,
    candidate,
    discovery,
    market,
    confirmation,
    pullback,
    bindingChecks,
    pullbackSource: {
      pairAddress: input.pullbackPairAddress,
      candleTimestampsSeconds: input.minuteCandles.map(
        (candle) => candle.timestampSeconds
      ),
    },
    reasons: [...new Set(reasons)],
  };
}

export function assertScalpEntryDecision(
  decision: ScalpEntryDecision
): asserts decision is ScalpEntryDecision & { accepted: true } {
  const snapshotMatches =
    decision.selectedMint.length > 0 &&
    decision.selectedMint === decision.candidate.mint &&
    decision.selectedMint === decision.market.mint &&
    decision.pullbackSource.pairAddress === decision.candidate.pairAddress;
  if (!decision.accepted || !snapshotMatches) {
    const reasons = decision.reasons.length
      ? decision.reasons.join(",")
      : "selected_snapshot_mismatch";
    throw new Error(`scalp entry blocked: ${reasons}`);
  }
}
