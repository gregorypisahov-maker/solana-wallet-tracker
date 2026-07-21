import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=5m&page=1";
const DEX = "https://api.dexscreener.com/tokens/v1/solana";
const INTERVAL_MS = 60_000;
const CHECK_MS = 5_000;
const FRICTION_PCT = 1.2;
const SUSPECT_DROP_PCT = 90;
const SUSPECT_CONFIRM_MS = 10_000;
const SHADOW_COOLDOWN_MS = 4 * 60 * 60 * 1000;
let scanning = false;
let checking = false;

const suspectPrices = new Map<string, { price: number; seenAt: number }>();

type Config = {
  enabled: boolean; strategy_version: string; min_liquidity_usd: number; min_market_cap_usd: number;
  max_market_cap_usd: number; min_liquidity_to_mcap: number; min_five_minute_change_pct: number;
  max_five_minute_change_pct: number; min_fifteen_minute_change_pct: number; max_fifteen_minute_change_pct: number;
  min_volume_usd: number; min_buyers: number; min_buy_sell_ratio: number; min_pool_age_minutes: number;
  max_pool_age_minutes: number; hard_stop_loss_pct: number; target_profit_pct: number;
  trailing_activation_pct: number; trailing_giveback_pct: number; max_hold_seconds: number;
  fixed_size_sol: number; max_concurrent_positions: number;
};

type Candidate = {
  mint: string; symbol: string; pairAddress: string; priceUsd: number; liquidityUsd: number;
  marketCapUsd: number; change5m: number; change15m: number; volume5m: number;
  buys5m: number; sells5m: number; buyers5m: number; poolAgeMinutes: number;
};

const n = (v: unknown, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const strip = (v: unknown) => String(v ?? "").replace(/^solana_/, "");

async function json(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "solana-scalper-shadow/2.0" } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function enabledContext(): Promise<{ enabled: boolean; rules: Config }> {
  const [{ data: rules, error: configError }, { data: state, error: stateError }] = await Promise.all([
    supabase.from("scalper_shadow_config").select("*").eq("id", 1).single(),
    supabase.from("scalper_shadow_state").select("enabled").eq("id", 1).single(),
  ]);
  if (configError) throw configError;
  if (stateError) throw stateError;
  return { enabled: Boolean(rules?.enabled) && Boolean(state?.enabled), rules: rules as Config };
}

async function candidates(): Promise<Candidate[]> {
  const body: any = await json(GECKO);
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map((row: any) => {
    const a = row?.attributes ?? {};
    const created = Date.parse(String(a.pool_created_at ?? ""));
    const tx = a.transactions?.m5 ?? {};
    return {
      mint: strip(row?.relationships?.base_token?.data?.id), symbol: String(a.name ?? "UNKNOWN").split("/")[0].trim(),
      pairAddress: String(a.address ?? ""), priceUsd: n(a.base_token_price_usd, NaN), liquidityUsd: n(a.reserve_in_usd, NaN),
      marketCapUsd: n(a.market_cap_usd ?? a.fdv_usd, NaN), change5m: n(a.price_change_percentage?.m5, NaN),
      change15m: n(a.price_change_percentage?.m15, NaN), volume5m: n(a.volume_usd?.m5, NaN), buys5m: n(tx.buys, NaN),
      sells5m: n(tx.sells, NaN), buyers5m: n(tx.buyers, NaN), poolAgeMinutes: Number.isFinite(created) ? (Date.now() - created) / 60_000 : NaN,
    };
  }).filter((c: Candidate) => c.mint && c.pairAddress && Object.values(c).every((v) => typeof v !== "number" || Number.isFinite(v)));
}

function passes(c: Candidate, r: Config) {
  const ratio = c.liquidityUsd / Math.max(1, c.marketCapUsd);
  const flow = c.buys5m / Math.max(1, c.sells5m);
  return c.liquidityUsd >= r.min_liquidity_usd && c.marketCapUsd >= r.min_market_cap_usd && c.marketCapUsd <= r.max_market_cap_usd &&
    ratio >= r.min_liquidity_to_mcap && c.change5m >= r.min_five_minute_change_pct && c.change5m <= r.max_five_minute_change_pct &&
    c.change15m >= r.min_fifteen_minute_change_pct && c.change15m <= r.max_fifteen_minute_change_pct && c.volume5m >= r.min_volume_usd &&
    c.buyers5m >= r.min_buyers && flow >= r.min_buy_sell_ratio && c.poolAgeMinutes >= r.min_pool_age_minutes && c.poolAgeMinutes <= r.max_pool_age_minutes;
}

function score(c: Candidate, r: Config) {
  const ratio = c.liquidityUsd / Math.max(1, c.marketCapUsd);
  const flow = c.buys5m / Math.max(1, c.sells5m);
  return Math.round(Math.min(100, Math.min(25, c.change5m / Math.max(1, r.max_five_minute_change_pct) * 25) +
    Math.min(20, c.change15m / Math.max(1, r.max_fifteen_minute_change_pct) * 20) + Math.min(20, c.volume5m / 25_000 * 20) +
    Math.min(15, c.buyers5m / 60 * 15) + Math.min(10, ratio / 0.5 * 10) + Math.min(10, flow / 2 * 10)));
}

async function dexPrice(mint: string, pairAddress: string) {
  const body: any = await json(`${DEX}/${encodeURIComponent(mint)}`);
  const pairs = Array.isArray(body) ? body : [];
  const pair = pairs.find((p: any) => p.pairAddress === pairAddress);
  if (!pair) throw new Error("bound pair unavailable");
  return n(pair.priceUsd, NaN);
}

async function isShadowBlacklisted(mint: string): Promise<boolean> {
  const { data, error } = await supabase.from("scalper_shadow_blacklist").select("mint").eq("mint", mint)
    .gt("blacklisted_until", new Date().toISOString()).limit(1);
  if (error) throw new Error(`shadow blacklist lookup failed: ${error.message}`);
  return Boolean(data?.length);
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const { enabled, rules } = await enabledContext();
    if (!enabled) { console.log("[scalper-shadow] idle: disabled"); return; }
    const [{ data: positions, error }, list] = await Promise.all([supabase.from("scalper_shadow_positions").select("*"), candidates()]);
    if (error) throw error;
    if ((positions ?? []).length >= rules.max_concurrent_positions) return;
    const openMints = new Set((positions ?? []).map((p: any) => p.mint));
    const eligible: Candidate[] = [];
    for (const candidate of list.filter((c) => !openMints.has(c.mint) && passes(c, rules)).sort((a,b)=>score(b,rules)-score(a,rules))) {
      if (!(await isShadowBlacklisted(candidate.mint))) eligible.push(candidate);
    }
    const pick = eligible[0];
    if (!pick) return;
    const { enabled: stillEnabled } = await enabledContext();
    if (!stillEnabled) return;
    const { error: insertError } = await supabase.from("scalper_shadow_positions").insert({
      position_id: randomUUID(), mint: pick.mint, token_symbol: pick.symbol, pair_address: pick.pairAddress,
      entry_price_usd: pick.priceUsd, entry_time: new Date().toISOString(), size_sol: rules.fixed_size_sol,
      peak_price_usd: pick.priceUsd, last_price_usd: pick.priceUsd,
      entry_snapshot: { candidate: pick, score: score(pick, rules), strategyVersion: rules.strategy_version, config: rules },
    });
    if (insertError) throw insertError;
    console.log(`[scalper-shadow] opened ${pick.symbol} score ${score(pick,rules)}`);
  } finally { scanning = false; }
}

function confirmedExitPrice(positionId: string, entry: number, price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const dropPct = (1 - price / entry) * 100;
  if (dropPct <= SUSPECT_DROP_PCT) { suspectPrices.delete(positionId); return true; }
  const prior = suspectPrices.get(positionId);
  const now = Date.now();
  if (!prior || now - prior.seenAt < SUSPECT_CONFIRM_MS) {
    if (!prior) suspectPrices.set(positionId, { price, seenAt: now });
    return false;
  }
  suspectPrices.delete(positionId);
  return true;
}

async function check() {
  if (checking) return;
  checking = true;
  try {
    const { enabled, rules } = await enabledContext();
    if (!enabled) { console.log("[scalper-shadow] idle: disabled"); return; }
    const { data: positions, error } = await supabase.from("scalper_shadow_positions").select("*");
    if (error) throw error;
    for (const p of positions ?? []) {
      try {
        const price = await dexPrice(p.mint, p.pair_address);
        const entry = n(p.entry_price_usd, NaN);
        if (!confirmedExitPrice(p.position_id, entry, price)) {
          console.warn(`[scalper-shadow] price_fetch_suspect ${p.token_symbol} entry=${entry} fetched=${price}`);
          continue;
        }
        const oldPeak = n(p.peak_price_usd, entry); const peak = Math.max(oldPeak, price);
        const gross = (price / entry - 1) * 100; const net = gross - FRICTION_PCT;
        const peakNet = (peak / entry - 1) * 100 - FRICTION_PCT;
        const held = (Date.now() - Date.parse(p.entry_time)) / 1000;
        let reason: string | null = null;
        if (net <= -rules.hard_stop_loss_pct) reason = "hard_stop";
        else if (net >= rules.target_profit_pct) reason = "take_profit";
        else if (peakNet >= rules.trailing_activation_pct && net <= peakNet - rules.trailing_giveback_pct) reason = "trailing_stop";
        else if (held >= rules.max_hold_seconds) reason = "max_hold_time";
        if (!reason) {
          await supabase.from("scalper_shadow_positions").update({ peak_price_usd: peak, last_price_usd: price }).eq("position_id", p.position_id);
          continue;
        }
        const { enabled: stillEnabled } = await enabledContext();
        if (!stillEnabled) return;
        const pnl = n(p.size_sol) * net / 100;
        const { data: state } = await supabase.from("scalper_shadow_state").select("bankroll_sol").eq("id",1).single();
        await supabase.from("scalper_shadow_trades").insert({ position_id:p.position_id,mint:p.mint,token_symbol:p.token_symbol,
          entry_price_usd:entry,exit_price_usd:price,size_sol:p.size_sol,pnl_sol:pnl,net_return_pct:net,exit_reason:reason,
          opened_at:p.entry_time,closed_at:new Date().toISOString(),entry_snapshot:p.entry_snapshot,
          exit_snapshot:{price,peak,peakNet,strategyVersion:rules.strategy_version} });
        await supabase.from("scalper_shadow_positions").delete().eq("position_id",p.position_id);
        await supabase.from("scalper_shadow_state").update({ bankroll_sol: n(state?.bankroll_sol, 1) + pnl, updated_at:new Date().toISOString() }).eq("id",1);
        await supabase.from("scalper_shadow_blacklist").upsert({ mint:p.mint, blacklisted_until:new Date(Date.now()+SHADOW_COOLDOWN_MS).toISOString(), reason:`shadow_exit:${reason}` }, { onConflict:"mint" });
        console.log(`[scalper-shadow] closed ${p.token_symbol} ${reason} ${pnl.toFixed(5)} SOL`);
      } catch (e) { console.warn(`[scalper-shadow] position check failed ${p.token_symbol}`, e); }
    }
  } finally { checking = false; }
}

export function startScalperShadowScheduler() {
  console.log("[scalper-shadow] guarded scheduler loaded; database enabled flags control activity");
  void scan().catch(console.error); void check().catch(console.error);
  setInterval(() => void scan().catch(console.error), INTERVAL_MS);
  setInterval(() => void check().catch(console.error), CHECK_MS);
}
