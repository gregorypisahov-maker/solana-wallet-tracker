import { getSupabaseAdmin } from "../lib/supabase";
import { evaluateLiquiditySafety } from "../live-executor/liquiditySafety";

const VERSION = "lp_lock_goplus_onchain_v1_2026_07_30";
const supabase = getSupabaseAdmin();

type Subject = {
  subjectType: "candidate" | "trade";
  subjectId: string;
  mint: string;
  tokenSymbol: string | null;
  pairAddress: string | null;
  observedAt: string | null;
  isPapoi: boolean;
};

async function subjects(): Promise<Subject[]> {
  const { data: candidates, error: candidateError } = await supabase
    .from("market_opportunities")
    .select("mint,token_symbol,pair_address,last_seen_at,score")
    .order("score", { ascending: false })
    .limit(30);
  if (candidateError) throw new Error(candidateError.message);

  const { data: recentTrades, error: tradeError } = await supabase
    .from("ai_discovery_trades")
    .select("id,mint,token_symbol,pair_address,opened_at,closed_at")
    .order("closed_at", { ascending: false })
    .limit(20);
  if (tradeError) throw new Error(tradeError.message);

  const { data: papoiTrades, error: papoiError } = await supabase
    .from("ai_discovery_trades")
    .select("id,mint,token_symbol,pair_address,opened_at,closed_at")
    .ilike("token_symbol", "%Papoi%")
    .order("closed_at", { ascending: false })
    .limit(5);
  if (papoiError) throw new Error(papoiError.message);

  const output: Subject[] = [];
  for (const row of candidates ?? []) {
    output.push({
      subjectType: "candidate",
      subjectId: `${row.mint}:${row.last_seen_at}`,
      mint: row.mint,
      tokenSymbol: row.token_symbol ?? null,
      pairAddress: row.pair_address ?? null,
      observedAt: row.last_seen_at ?? null,
      isPapoi: false,
    });
  }

  const seenTrades = new Set<number>();
  for (const row of [...(papoiTrades ?? []), ...(recentTrades ?? [])]) {
    if (seenTrades.has(Number(row.id))) continue;
    seenTrades.add(Number(row.id));
    output.push({
      subjectType: "trade",
      subjectId: String(row.id),
      mint: row.mint,
      tokenSymbol: row.token_symbol ?? null,
      pairAddress: row.pair_address ?? null,
      observedAt: row.opened_at ?? row.closed_at ?? null,
      isPapoi: /papoi/i.test(String(row.token_symbol ?? "")),
    });
  }
  return output;
}

async function audit(subject: Subject): Promise<{ verdict: string; papoiPassed: boolean | null } | null> {
  const { data: existing, error: existingError } = await supabase
    .from("lp_lock_shadow_audits")
    .select("id")
    .eq("detector_version", VERSION)
    .eq("subject_type", subject.subjectType)
    .eq("subject_id", subject.subjectId)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing) return null;

  const result = await evaluateLiquiditySafety({
    mint: subject.mint,
    pairAddress: subject.pairAddress,
  });
  const protectivePass = subject.isPapoi ? result.verdict === "UNLOCKED" : null;
  const { error } = await supabase.from("lp_lock_shadow_audits").insert({
    detector_version: VERSION,
    subject_type: subject.subjectType,
    subject_id: subject.subjectId,
    mint: subject.mint,
    token_symbol: subject.tokenSymbol,
    pair_address: subject.pairAddress,
    source_observed_at: subject.observedAt,
    verdict: result.verdict,
    method: result.method,
    source: result.source,
    result,
    protective_pass: protectivePass,
  });
  if (error && error.code !== "23505") throw new Error(error.message);

  const pctLocked = result.pctLocked == null ? "unknown" : result.pctLocked.toFixed(2);
  const pctBurned = result.pctBurned == null ? "unknown" : result.pctBurned.toFixed(2);
  console.log(
    `[lp-lock-audit] ${subject.subjectType} ${subject.tokenSymbol ?? subject.mint} ` +
      `verdict=${result.verdict} method=${result.method} source=${result.source} ` +
      `pctLocked=${pctLocked} pctBurned=${pctBurned} pool=${result.poolAddress ?? "unknown"}`
  );
  if (subject.isPapoi && !protectivePass) {
    console.error(
      `[lp-lock-audit] Papoi protective acceptance FAILED verdict=${result.verdict} method=${result.method}`
    );
  }
  return { verdict: result.verdict, papoiPassed: protectivePass };
}

async function main(): Promise<void> {
  const all = await subjects();
  const results: Array<{ verdict: string; papoiPassed: boolean | null }> = [];
  const concurrency = 3;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < all.length) {
        const index = cursor;
        cursor += 1;
        try {
          const value = await audit(all[index]);
          if (value) results.push(value);
        } catch (error) {
          console.warn(
            `[lp-lock-audit] ${all[index].subjectType} ${all[index].tokenSymbol ?? all[index].mint} failed`,
            error
          );
        }
      }
    })
  );

  const measured = results.length;
  const unknown = results.filter((item) => item.verdict === "UNKNOWN").length;
  const unknownPct = measured ? Number(((unknown / measured) * 100).toFixed(1)) : 0;
  const papoi = results.find((item) => item.papoiPassed != null)?.papoiPassed ?? null;
  console.log(
    `[lp-lock-audit] summary version=${VERSION} measured=${measured} unknown=${unknown} ` +
      `unknownPct=${unknownPct} papoiProtective=${papoi ?? "not_measured"} enforce=false blockOnUnknown=false`
  );
  if (measured > 0 && unknownPct >= 80) {
    console.error("[lp-lock-audit] acceptance FAILED: UNKNOWN rate is at least 80%; keep enforcement off");
  }
}

main().catch((error) => {
  console.warn("[lp-lock-audit] audit failed; worker startup continues", error);
  process.exitCode = 0;
});
