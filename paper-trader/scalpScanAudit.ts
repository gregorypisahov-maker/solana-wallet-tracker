import type {
  CandidateEvaluation,
  ScalpCandidate,
} from "./momentumScalperRules";
import type { ScalpEntryDecision } from "./scalpEntryDecision";

export type ScanTopCandidate = {
  candidate: ScalpCandidate;
  evaluation: CandidateEvaluation;
};

export function buildScalpScanAudit(input: {
  strategyVersion: string;
  topBeforeSelection: ScanTopCandidate | null;
  selectedDecision: ScalpEntryDecision | null;
  candidateDecisions: unknown[];
}) {
  const selected = input.selectedDecision;
  const displayedTop: ScanTopCandidate | null = selected
    ? { candidate: selected.candidate, evaluation: selected.discovery }
    : input.topBeforeSelection;
  const selectedSnapshotMatches = !selected || (
    selected.selectedMint === selected.candidate.mint &&
    selected.selectedMint === selected.market.mint &&
    selected.pullbackSource.pairAddress === selected.candidate.pairAddress
  );

  return {
    topSymbol: displayedTop?.candidate.symbol ?? null,
    topMint: displayedTop?.candidate.mint ?? null,
    topScore: displayedTop?.evaluation.score ?? null,
    selectedMint: selected?.selectedMint ?? null,
    snapshot: {
      strategyVersion: input.strategyVersion,
      entered: Boolean(selected),
      selectedMint: selected?.selectedMint ?? null,
      selectedSnapshotMatches,
      selectedSnapshot: selected,
      topBeforeSelection: input.topBeforeSelection,
      candidateDecisions: input.candidateDecisions,
    },
  };
}
