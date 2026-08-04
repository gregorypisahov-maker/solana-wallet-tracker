import { Connection, PublicKey } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";

const supabase = getSupabaseAdmin();
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dk2DaMAMiF6m6W7xL8j8QF6oM8Z4xZpS");
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RETRY_MS = Math.max(100, Number(process.env.SNIPER_ROUTE_RETRY_MS || 250));
const CANDIDATE_TTL_MS = Math.max(15_000, Number(process.env.SNIPER_CANDIDATE_TTL_MS || 90_000));
const POSITION_SIZE_SOL = Math.max(0.01, Number(process.env.SNIPER_POSITION_SIZE_SOL || 0.2));
const SLIPPAGE_BPS = Math.max(50, Number(process.env.SNIPER_SLIPPAGE_BPS || 500));
const MAX_OPEN = Math.max(1, Number(process.env.SNIPER_MAX_OPEN_POSITIONS || 1));
const DEX_TOKEN_URL = "https://api.dexscreener.com/tokens/v1/solana";
const seen = new Map<string, number>();
const pending = new Map<string, { mint: string; signature: string; detectedAt: number; attempts: number }>();
let processing = false;

function rpcUrl() {
  const key = process.env.HELIUS_API_KEY || "";
  return process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${key}`;
}
function wsUrl() {
  const key = process.env.HELIUS_API_KEY || "";
  return process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${key}`;
}
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function lamports(sol: number) { return String(Math.floor(sol * 1_000_000_000)); }

async function logRun(status: string, mint: string | null, message: string) {
  await supabase.from("scalp_scan_runs").insert({
    created_at: new Date().toISOString(), status, scanned_count: 1,
    qualified_count: status === "entered" ? 1 : 0, top_symbol: mint ? mint.slice(0, 8) : null,
    top_score: null, selected_mint: status === "entered" ? mint : null, message,
  });
}

async function extractNewMint(connection: Connection, signature: string): Promise<string | null> {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx?.meta || tx.meta.err) return null;
  const pre = new Set((tx.meta.preTokenBalances || []).map((b) => b.mint));
  for (const balance of tx.meta.postTokenBalances || []) {
    if (balance.mint !== JUPITER_SOL_MINT && !pre.has(balance.mint)) return balance.mint;
  }
  const keys = tx.transaction.message.accountKeys.map((k: any) => String(k.pubkey || k));
  const tokenProgramIndex = keys.indexOf(TOKEN_PROGRAM);
  if (tokenProgramIndex < 0) return null;
  return (tx.meta.postTokenBalances || []).find((b) => b.mint !== JUPITER_SOL_MINT)?.mint || null;
}

async function dexPair(mint: string) {
  const response = await fetch(`${DEX_TOKEN_URL}/${encodeURIComponent(mint)}`, { cache: "no-store" });
  if (!response.ok) return null;
  const pairs = await response.json() as any[];
  const pair = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p?.chainId === "solana" && p?.baseToken?.address === mint && Number(p?.liquidity?.usd || 0) > 0)
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];
  if (!pair) return null;
  return { address: String(pair.pairAddress), priceUsd: Number(pair.priceUsd || 0), symbol: String(pair.baseToken?.symbol || mint.slice(0, 8)) };
}

async function canEnter() {
  const [{ data: state }, { count }] = await Promise.all([
    supabase.from("scalp_state").select("enabled,halted,bankroll_sol").eq("id", 1).single(),
    supabase.from("scalp_positions").select("position_id", { count: "exact", head: true }),
  ]);
  return Boolean(state?.enabled && !state?.halted && Number(state?.bankroll_sol || 0) >= POSITION_SIZE_SOL && Number(count || 0) < MAX_OPEN);
}

async function attemptEntry(item: { mint: string; signature: string; detectedAt: number; attempts: number }) {
  if (!(await canEnter())) return false;
  const buy = await getJupiterQuote({ inputMint: JUPITER_SOL_MINT, outputMint: item.mint, rawTokenAmount: lamports(POSITION_SIZE_SOL), slippageBps: SLIPPAGE_BPS });
  if (!buy.route || buy.outLamports <= 0n) return false;
  const sell = await getJupiterQuote({ inputMint: item.mint, outputMint: JUPITER_SOL_MINT, rawTokenAmount: buy.outLamports.toString(), slippageBps: SLIPPAGE_BPS });
  if (!sell.route || sell.outLamports <= 0n) return false;
  const roundTripSol = Number(sell.outLamports) / 1_000_000_000;
  if (roundTripSol < POSITION_SIZE_SOL * 0.82) return false;
  const pair = await dexPair(item.mint);
  if (!pair || !Number.isFinite(pair.priceUsd) || pair.priceUsd <= 0) return false;
  const positionId = randomUUID();
  const now = new Date().toISOString();
  const { error } = await supabase.from("scalp_positions").insert({
    position_id: positionId, mint: item.mint, token_symbol: pair.symbol, pair_address: pair.address,
    entry_price_usd: pair.priceUsd, entry_time: now, size_sol: POSITION_SIZE_SOL,
    peak_price_usd: pair.priceUsd, last_price_usd: pair.priceUsd, last_checked_at: now, updated_at: now,
    entry_snapshot: { source: "helius_websocket", detection_signature: item.signature, detected_at: new Date(item.detectedAt).toISOString(), detection_to_entry_ms: Date.now() - item.detectedAt, attempts: item.attempts, jupiter_buy: buy.raw, jupiter_sell_check: sell.raw, immediate_round_trip_sol: roundTripSol, paper_only: true },
  });
  if (error) throw error;
  await supabase.from("scalp_state").update({
    bankroll_sol: supabase.rpc ? undefined : undefined,
    armed_mint: null, armed_token_symbol: null, last_scan_at: now, updated_at: now,
  }).eq("id", 1);
  await supabase.rpc("debit_paper_scalp_entry", { p_position_size_sol: POSITION_SIZE_SOL }).then(() => undefined, () => undefined);
  await logRun("entered", item.mint, `helius_ws_to_jupiter_entry ${Date.now() - item.detectedAt}ms attempts=${item.attempts}`);
  console.log(`[helius-sniper] ENTER ${pair.symbol} mint=${item.mint} latency=${Date.now() - item.detectedAt}ms attempts=${item.attempts}`);
  return true;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    const now = Date.now();
    for (const [mint, item] of pending) {
      if (now - item.detectedAt > CANDIDATE_TTL_MS) {
        pending.delete(mint);
        await logRun("expired", mint, `no executable Jupiter round trip within ${CANDIDATE_TTL_MS}ms`);
        continue;
      }
      item.attempts += 1;
      try {
        if (await attemptEntry(item)) pending.delete(mint);
      } catch (error) {
        console.warn(`[helius-sniper] attempt failed mint=${mint}`, error);
      }
    }
  } finally { processing = false; }
}

export function startHeliusMillisecondSniper() {
  if (["0", "false", "off"].includes(String(process.env.ENABLE_HELIUS_MILLISECOND_SNIPER || "true").toLowerCase())) return;
  const connection = new Connection(rpcUrl(), { commitment: "confirmed", wsEndpoint: wsUrl(), disableRetryOnRateLimit: false });
  connection.onLogs(PUMP_PROGRAM, async ({ signature, err, logs }) => {
    if (err || !logs.some((line) => /Instruction: (Create|CreateV2)/i.test(line))) return;
    const detectedAt = Date.now();
    try {
      const mint = await extractNewMint(connection, signature);
      if (!mint || seen.has(mint)) return;
      seen.set(mint, detectedAt);
      pending.set(mint, { mint, signature, detectedAt, attempts: 0 });
      await logRun("detected", mint, `helius websocket launch signature=${signature}`);
      void processQueue();
    } catch (error) {
      console.warn(`[helius-sniper] detection parse failed signature=${signature}`, error);
    }
  }, "confirmed").then((id) => console.log(`[helius-sniper] websocket active subscription=${id} retry=${RETRY_MS}ms ttl=${CANDIDATE_TTL_MS}ms`));
  setInterval(() => void processQueue(), RETRY_MS);
  setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [mint, at] of seen) if (at < cutoff) seen.delete(mint);
  }, 60_000);
  void sleep(0);
}
