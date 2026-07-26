export type MoonshotMode = "disabled" | "shadow" | "active";

export type MoonshotInput = {
  grossReturnPct: number;
  peakReturnPct: number;
  pullbackFromPeakPct: number;
  heldMs: number;
  liquidityUsd?: number;
  executableMultiple?: number | null;
};

export type MoonshotDecision = {
  engaged: boolean;
  action: "normal_exit_logic" | "hold" | "exit";
  reason: string;
};

const num = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

export function moonshotMode(): MoonshotMode {
  const raw = (process.env.MOONSHOT_INTELLIGENCE_MODE ?? "disabled").trim().toLowerCase();
  return raw === "active" || raw === "shadow" ? raw : "disabled";
}

export function evaluateMoonshot(input: MoonshotInput): MoonshotDecision {
  const mode = moonshotMode();
  if (mode === "disabled") return { engaged: false, action: "normal_exit_logic", reason: "disabled" };

  // Handoff begins around the normal take-profit level. Shadow mode only records decisions.
  const triggerPct = Math.max(6, num("MOONSHOT_TRIGGER_GROSS_PCT", 10));
  const trailingDropPct = Math.max(10, num("MOONSHOT_TRAILING_DROP_PCT", 35));
  const maxHoldMs = Math.max(45 * 60_000, num("MOONSHOT_MAX_HOLD_MINUTES", 360) * 60_000);
  const minLiquidityUsd = Math.max(0, num("MOONSHOT_MIN_LIQUIDITY_USD", 25_000));

  const exceptionalMove = input.grossReturnPct >= triggerPct || input.peakReturnPct >= triggerPct;
  if (!exceptionalMove) return { engaged: false, action: "normal_exit_logic", reason: "trigger_not_reached" };

  if ((input.liquidityUsd ?? minLiquidityUsd) < minLiquidityUsd) {
    return { engaged: true, action: "exit", reason: "liquidity_below_floor" };
  }

  if (input.executableMultiple != null && input.executableMultiple < 1) {
    return { engaged: true, action: "exit", reason: "executable_value_below_entry" };
  }

  if (input.pullbackFromPeakPct <= -trailingDropPct) {
    return { engaged: true, action: "exit", reason: "moonshot_trailing_stop" };
  }

  if (input.heldMs >= maxHoldMs) {
    return { engaged: true, action: "exit", reason: "moonshot_max_hold" };
  }

  return { engaged: true, action: "hold", reason: mode === "shadow" ? "shadow_hold" : "moonshot_hold" };
}
