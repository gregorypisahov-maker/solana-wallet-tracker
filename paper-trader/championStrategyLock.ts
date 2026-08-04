import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();

type LockScope = "paper" | "research";

type LockRow = {
  locked: boolean;
  locked_until: string;
  reason: string;
  champion_paper_version: string;
  champion_research_version: string;
  paper_config: Record<string, unknown>;
  research_config: Record<string, unknown>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

async function haltScope(scope: LockScope, reason: string): Promise<void> {
  const now = new Date().toISOString();
  if (scope === "paper") {
    await supabase
      .from("champion_paper_state")
      .update({ halted: true, halt_reason: reason, updated_at: now })
      .eq("id", 1);
    return;
  }

  await supabase
    .from("champion_strategy_state")
    .update({ halt_reason: reason, updated_at: now })
    .eq("id", 1);
}

export async function enforceChampionStrategyLock(input: {
  scope: LockScope;
  version: string;
  config: Record<string, unknown>;
}): Promise<void> {
  const { data, error } = await supabase
    .from("champion_strategy_lock")
    .select("locked,locked_until,reason,champion_paper_version,champion_research_version,paper_config,research_config")
    .eq("id", 1)
    .single();

  if (error) throw new Error(`champion_strategy_lock_read_failed:${error.message}`);
  const row = data as LockRow;
  const active = Boolean(row.locked && Date.parse(row.locked_until) > Date.now());
  if (!active) {
    console.log(`[champion-lock] inactive scope=${input.scope} expired=${row.locked_until}`);
    return;
  }

  const expectedVersion = input.scope === "paper"
    ? row.champion_paper_version
    : row.champion_research_version;
  const expectedConfig = input.scope === "paper" ? row.paper_config : row.research_config;
  const versionMatches = input.version === expectedVersion;
  const configMatches = canonical(input.config) === canonical(expectedConfig);

  if (!versionMatches || !configMatches) {
    const reason = [
      "champion_strategy_lock_violation",
      `scope=${input.scope}`,
      `locked_until=${row.locked_until}`,
      `version_match=${versionMatches}`,
      `config_match=${configMatches}`,
    ].join(";");
    await haltScope(input.scope, reason);
    throw new Error(reason);
  }

  console.log(
    `[champion-lock] enforced scope=${input.scope} version=${input.version} ` +
    `lockedUntil=${row.locked_until} reason=${row.reason}`,
  );
}
