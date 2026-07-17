import React from "react";
import { getSupabaseAdmin } from "../lib/supabase";

interface ScalperControlsProps {
  state?: {
    enabled: boolean;
    halted: boolean;
    halt_reason: string | null;
    bankroll_sol: number | string;
    entries_today: number;
    consecutive_losses: number;
  };
}

export async function handleScalperResume(): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("scalp_state")
      .update({
        enabled: true,
        halted: false,
        halt_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    if (error) throw error;

    return {
      success: true,
      message: "Scalper resumed successfully",
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to resume: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function handleScalperPause(): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("scalp_state")
      .update({
        halted: true,
        halt_reason: "manual_pause",
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    if (error) throw error;

    return {
      success: true,
      message: "Scalper paused successfully",
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to pause: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function ScalperControls({ state }: ScalperControlsProps) {
  const isActive = state?.enabled && !state?.halted;

  return (
    <div className="scalperControls">
      <div className="controlStatus">
        <span className={`statusDot ${isActive ? "active" : "paused"}`} />
        <span className="statusText">
          {isActive ? "🟢 ACTIVE" : `🔴 ${state?.halt_reason ?? "PAUSED"}`}
        </span>
      </div>
      <div className="controlButtons">
        {isActive ? (
          <button
            className="btn btnPause"
            onClick={() => handleScalperPause()}
            title="Pause the scalper"
          >
            ⏸️ Pause Scalper
          </button>
        ) : (
          <button
            className="btn btnResume"
            onClick={() => handleScalperResume()}
            title="Resume the scalper"
          >
            ▶️ Resume Scalper
          </button>
        )}
      </div>
      <div className="controlInfo">
        <div>
          <span>Bankroll:</span>
          <strong>{Number(state?.bankroll_sol || 0).toFixed(4)} SOL</strong>
        </div>
        <div>
          <span>Entries:</span>
          <strong>
            {state?.entries_today ?? 0}/12
          </strong>
        </div>
        <div>
          <span>Losses:</span>
          <strong>
            {state?.consecutive_losses ?? 0}/3
          </strong>
        </div>
      </div>
    </div>
  );
}
