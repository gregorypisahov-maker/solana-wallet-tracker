import { Connection, PublicKey } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";

const supabase = getSupabaseAdmin();
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RETRY_MS = Math.max(100, Number(process.env.SNIPER_ROUTE_RETRY_MS || 250));
const TTL_MS = Math.max(15_000, Number(process.env.SNIPER_CANDIDATE_TTL_MS || 90_000));
const SIZE_SOL = Math.max(0.01, Number(process.env.SNIPER_POSITION_SIZE_SOL || 0.2));
const SLIPPAGE_BPS = Math.max(50, Number(process.env.SNIPER_SLIPPAGE_BPS || 500));
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const seen = new Map<string, number>();
const pending = new Map<string, { mint: string; signature: string; detectedAt: number; attempts: number; source: string }>();
let processing = false;

function rpcUrl() {
  const key = process.env.HELIUS_API_KEY?.trim() || "";
  return process.env.HELIUS_RPC_URL?.trim() || `https://mainnet.helius-rpc.com/?api-key=${key}`;
}
function wsUrl() {
  const key = process.env.HELIUS_API_KEY?.trim() || "";
  return process.env.HELIUS_WS_URL?.trim() || `wss://mainnet.helius-rpc.com/?api-key=${key}`;
}
function lamports(sol: number) { return String(Math.floor(sol * 1_000_000_000)); }

async function audit(kind: string, mint: string | null, message: string, selected = false) {
  const now = new Date().toISOString();
  await supabase.from("scalp_scan_runs").insert({
    started_at: now, finished_at: now, status: "ok", scanned_count: 1,
    qualified_count: selected ? 1 : 0, top_symbol: mint ? mint.slice(0, 8) : null,
    top_mint: mint, top_score: null, selected_mint: selected ? mint : null,
    message: `${kind}:${message}`, top_snapshot: { source: "helius_websocket", kind }, created_at: now,
  });
}

async function extractMint(connection: Connection, signature: string): Promise<string | null> {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx?.meta || tx.meta.err) return null;
  const before = new Set((tx.meta.preTokenBalances || []).map((b) => b.mint));
  return (tx.meta.postTokenBalances || []).find((b) => b.mint !== JUPITER_SOL_MINT && !before.has(b.mint))?.mint || null;
}

async function pairFor(mint: string) {
  const response = await fetch(`${DEX_URL}/${encodeURIComponent(mint)}`, { cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json() as any[];
  const pair = (Array.isArray(body) ? body : [])
    .filter((p) => p?.chainId === "solana" && p?.baseToken?.address === mint && Number(p?.priceUsd || 0) > 0)
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];
  return pair ? { address: String(pair.pairAddress), priceUsd: Number(pair.priceUsd), symbol: String(pair.baseToken?.symbol || mint.slice(0, 8)) } : null;
}

async function attempt(item: { mint: string; signature: string; detectedAt: number; attempts: number; source: string }) {
  const buy = await getJupiterQuote({ inputMint: JUPITER_SOL_MINT, outputMint: item.mint, rawTokenAmount: lamports(SIZE_SOL), slippageBps: SLIPPAGE_BPS });
  if (!buy.route || buy.outLamports <= 0n) return false;
  const sell = await getJupiterQuote({ inputMint: item.mint, outputMint: JUPITER_SOL_MINT, rawTokenAmount: buy.outLamports.toString(), slippageBps: SLIPPAGE_BPS });
  if (!sell.route || sell.outLamports <= 0n) return false;
  const roundTripSol = Number(sell.outLamports) / 1_000_000_000;
  if (roundTripSol < SIZE_SOL * 0.82) return false;
  const pair = await pairFor(item.mint);
  if (!pair) return false;
  const now = new Date().toISOString();
  const snapshot = {
    source: "helius_websocket", launch_source: item.source, detection_signature: item.signature,
    detected_at: new Date(item.detectedAt).toISOString(), detection_to_entry_ms: Date.now() - item.detectedAt,
    attempts: item.attempts, jupiter_buy: buy.raw, jupiter_sell_check: sell.raw,
    immediate_round_trip_sol: roundTripSol, paper_only: true,
  };
  const { error } = await supabase.rpc("open_paper_scalp", {
    p_position_id: randomUUID(), p_mint: item.mint, p_token_symbol: pair.symbol,
    p_pair_address: pair.address, p_entry_price_usd: pair.priceUsd, p_entry_time: now,
    p_size_sol: SIZE_SOL, p_entry_snapshot: snapshot,
  });
  if (error) {
    if (/already open|daily entry|disabled|halted|insufficient/i.test(error.message)) return false;
    throw error;
  }
  await audit("entered", item.mint, `latency_ms=${Date.now() - item.detectedAt};attempts=${item.attempts}`, true);
  console.log(`[helius-sniper] ENTER ${pair.symbol} ${item.mint} latency=${Date.now() - item.detectedAt}ms`);
  return true;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (const [mint, item] of pending) {
      if (Date.now() - item.detectedAt > TTL_MS) {
        pending.delete(mint);
        await audit("expired", mint, `no_executable_round_trip_within_ms=${TTL_MS}`);
        continue;
      }
      item.attempts += 1;
      try { if (await attempt(item)) pending.delete(mint); }
      catch (error) { console.warn(`[helius-sniper] route attempt failed mint=${mint}`, error); }
    }
  } finally { processing = false; }
}

function subscribe(connection: Connection, program: PublicKey, source: string) {
  return connection.onLogs(program, async ({ signature, err, logs }) => {
    if (err || !logs.some((line) => /Instruction: (Create|CreateV2|CreatePool)/i.test(line))) return;
    const detectedAt = Date.now();
    try {
      const mint = await extractMint(connection, signature);
      if (!mint || seen.has(mint)) return;
      seen.set(mint, detectedAt);
      pending.set(mint, { mint, signature, detectedAt, attempts: 0, source });
      await audit("detected", mint, `source=${source};signature=${signature}`);
      void processQueue();
    } catch (error) { console.warn(`[helius-sniper] parse failed ${signature}`, error); }
  }, "confirmed");
}

export function startHeliusMillisecondSniper() {
  if (["0", "false", "off"].includes(String(process.env.ENABLE_HELIUS_MILLISECOND_SNIPER || "true").toLowerCase())) return;
  if (!process.env.HELIUS_API_KEY && !process.env.HELIUS_RPC_URL) throw new Error("HELIUS_API_KEY_or_HELIUS_RPC_URL_missing");
  const connection = new Connection(rpcUrl(), { commitment: "confirmed", wsEndpoint: wsUrl(), disableRetryOnRateLimit: false });
  Promise.all([subscribe(connection, PUMP_PROGRAM, "pump_create"), subscribe(connection, PUMPSWAP_PROGRAM, "pumpswap_pool")])
    .then((ids) => console.log(`[helius-sniper] ACTIVE subscriptions=${ids.join(",")} retry=${RETRY_MS}ms ttl=${TTL_MS}ms`))
    .catch((error) => console.error("[helius-sniper] websocket subscription failed", error));
  setInterval(() => void processQueue(), RETRY_MS);
  setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [mint, at] of seen) if (at < cutoff) seen.delete(mint);
  }, 60_000);
}
