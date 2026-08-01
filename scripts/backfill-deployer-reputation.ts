import { getSupabaseAdmin } from "../lib/supabase";
import { resolveDeployer } from "../lib/deployerReputation";

const RUG_REASONS = new Set(["emergency_liquidity_drop", "liquidity_gone", "quote_unavailable_forced_exit"]);
const isRug = (t: any) => RUG_REASONS.has(String(t.exit_reason)) || Number(t.net_return_pct) <= -80;

async function main() {
  const supabase = getSupabaseAdmin();
  const { data: trades, error } = await supabase.from("ai_discovery_trades").select("mint,opened_at,closed_at,exit_reason,net_return_pct").order("opened_at");
  if (error) throw new Error(error.message);
  const mints = [...new Set((trades ?? []).map((t: any) => String(t.mint)))];
  for (const [index, mint] of mints.entries()) {
    const resolved = await resolveDeployer(mint);
    console.log(`[deployer-backfill] ${index + 1}/${mints.length} mint=${mint} deployer=${resolved.deployer ?? "unresolved"} method=${resolved.method}`);
  }
  const byDeployer = new Map<string, any[]>();
  const { data: cache, error: cacheError } = await supabase.from("deployer_by_mint").select("mint,deployer").in("mint", mints);
  if (cacheError) throw new Error(cacheError.message);
  const deployerFor = new Map((cache ?? []).map((r: any) => [r.mint, r.deployer]));
  for (const trade of trades ?? []) {
    const deployer = deployerFor.get(trade.mint);
    if (!deployer) continue;
    const rows = byDeployer.get(deployer) ?? [];
    rows.push(trade);
    byDeployer.set(deployer, rows);
  }
  for (const [deployer, rows] of byDeployer) {
    const uniqueMints = [...new Set(rows.map((r) => r.mint))];
    const rugRows = rows.filter(isRug);
    const sampleRugMints = [...new Set(rugRows.map((r) => r.mint))].slice(0, 20);
    const lastRugAt = rugRows.map((r) => r.closed_at).filter(Boolean).sort().at(-1) ?? null;
    const firstSeenAt = rows.map((r) => r.opened_at).filter(Boolean).sort()[0] ?? new Date().toISOString();
    const { error: upsertError } = await supabase.from("deployer_reputation").upsert({ deployer, tokens_seen: uniqueMints.length, rugs: sampleRugMints.length, first_seen_at: firstSeenAt, last_rug_at: lastRugAt, sample_rug_mints: sampleRugMints, updated_at: new Date().toISOString() });
    if (upsertError) throw new Error(upsertError.message);
  }
  console.log(`[deployer-backfill] complete mints=${mints.length} deployers=${byDeployer.size}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
