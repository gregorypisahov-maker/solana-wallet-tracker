export interface ReadinessInput {
  completedPositions: number;
  totalPnlSol: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  halted: boolean;
}

export interface ReadinessCheck {
  label: string;
  passed: boolean;
  actual: string;
  target: string;
}

export function evaluatePaperReadiness(input: ReadinessInput): {
  ready: boolean;
  checks: ReadinessCheck[];
} {
  const checks: ReadinessCheck[] = [
    {
      label: "Clean sample",
      passed: input.completedPositions >= 100,
      actual: `${input.completedPositions} positions`,
      target: "at least 100",
    },
    {
      label: "Net result",
      passed: input.totalPnlSol > 0,
      actual: `${input.totalPnlSol >= 0 ? "+" : ""}${input.totalPnlSol.toFixed(3)} SOL`,
      target: "positive",
    },
    {
      label: "Profit factor",
      passed: input.profitFactor !== null && input.profitFactor >= 1.3,
      actual: input.profitFactor === null ? "not available" : input.profitFactor.toFixed(2),
      target: "at least 1.30",
    },
    {
      label: "Max drawdown",
      passed: input.maxDrawdownPct <= 10,
      actual: `${input.maxDrawdownPct.toFixed(1)}%`,
      target: "10% or less",
    },
    {
      label: "Safety halt",
      passed: !input.halted,
      actual: input.halted ? "halted" : "clear",
      target: "clear",
    },
  ];

  return {
    ready: checks.every((check) => check.passed),
    checks,
  };
}
