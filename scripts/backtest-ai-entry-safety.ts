import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";
import { checkTokenSafety } from "../lib/tokenSafety";

const supabase = getSupabaseAdmin();
const RUG_REASONS = new Set([
  "liquidity_gone",
  "price_vanished",
  "emergency_liquidity_drop",
  "max_hold_price_unavailable",
]);

type Trade = {
  id: number;
  mint: string | null;
  token_symbol: string | null;
  pnl_sol: number | string;
  exit_reason: string | null;
  entry_snapshot: any;
};

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function main(): Promise<void> {
  const { data, error } = await supabase
    .from("ai_discovery_trades")
    .select("id,mint,token_symbol,pnl_sol,exit_reason,entry_snapshot")
    .order("opened_at", { ascending: true });
  if (error) throw new Error(error.message);

  const trades = (data ?? []) as Trade[];
  const retained: Array<Trade & { safety: any }> = [];
  const rejected: Array<Trade & { safety: any }> = [];
  const perCheck = new Map<string, number>();

  for (const trade of trades) {
    const mint = trade.entry_snapshot?.opportunity?.mint ?? trade.mint;
    if (!mint) throw new Error(`historical_trade_missing_mint:${trade.id}`);
    const safety = await checkTokenSafety(String(mint));
    const row = { ...trade, safety };
    if (safety.passed) retained.push(row);
    else {
      rejected.push(row);
      const check = safety.checkFailed ?? "rpc_unknown";
      perCheck.set(check, (perCheck.get(check) ?? 0) + 1);
    }
  }

  const summarize = (rows: Array<Trade & { safety: any }>) => {
    const rugs = rows.filter((row) => RUG_REASONS.has(String(row.exit_reason)));
    const pnl = rows.reduce((sum, row) => sum + n(row.pnl_sol), 0);
    return {
      trades: rows.length,
      rugs: rugs.length,
      rugRatePct: rows.length ? (rugs.length / rows.length) * 100 : 0,
      truePnlSol: pnl,
      perTradeSol: rows.length ? pnl / rows.length : 0,
    };
  };

  const named = (symbol: string) => {
    const row = [...retained, ...rejected].find(
      (item) => String(item.token_symbol).toLowerCase() === symbol.toLowerCase()
    );
    return row
      ? {
          symbol: row.token_symbol,
          retained: row.safety.passed,
          checkFailed: row.safety.checkFailed,
          observedValue: row.safety.observedValue,
        }
      : { symbol, found: false };
  };

  const result = {
    generatedAt: new Date().toISOString(),
    flags: {
      S2: process.env.AI_TOKEN_SAFETY_S2_ENABLED !== "false",
      S3: process.env.AI_TOKEN_SAFETY_S3_ENABLED !== "false",
      S4: process.env.AI_TOKEN_SAFETY_S4_ENABLED === "true",
    },
    all: summarize([...retained, ...rejected]),
    retained: summarize(retained),
    rejected: summarize(rejected),
    retentionPct: trades.length ? (retained.length / trades.length) * 100 : 0,
    perCheckRejections: Object.fromEntries([...perCheck.entries()].sort()),
    namedTokens: [named("Grok"), named("Papoi")],
    caveat:
      "This uses current on-chain state after historical outcomes. S1/S4/S5/S6 are outcome-contaminated for rugged tokens; S2/S3 are the least contaminated. Report authority-only and enriched checks separately.",
  };

  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error("[backtest-ai-entry-safety] failed", error);
  process.exitCode = 1;
});
