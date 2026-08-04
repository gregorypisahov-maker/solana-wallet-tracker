import { Connection, PublicKey } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";
import { conservativeQuoteOutputRaw, conservativeSolProceeds, legOverheadSol, routeFeeSummary } from "../paper-trader/liveCostSimulation";

const supabase = getSupabaseAdmin();
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RETRY_MS = Math.max(100, Number(process.env.SNIPER_ROUTE_RETRY_MS || 250));
const TTL_MS = Math.max(3_000, Number(process.env.SNIPER_CANDIDATE_TTL_MS || 8_000));
const SIZE_SOL = Math.max(0.01, Number(process.env.SNIPER_POSITION_SIZE_SOL || 0.2));
const SLIPPAGE_BPS = Math.min(200, Math.max(10, Number(process.env.SNIPER_SLIPPAGE_BPS || 200)));
const HEARTBEAT_MS = Math.max(300_000, Number(process.env.SNIPER_TELEGRAM_HEARTBEAT_MS || 1_800_000));
const DETECTION_ALERT_MIN_MS = Math.max(0, Number(process.env.SNIPER_TELEGRAM_DETECTION_MIN_INTERVAL_MS || 15_000));
const JUPITER_MIN_INTERVAL_MS = Math.max(250, Number(process.env.SNIPER_JUPITER_MIN_INTERVAL_MS || 800));
const JUPITER_429_BACKOFF_MS = Math.max(2_000, Number(process.env.SNIPER_JUPITER_429_BACKOFF_MS || 10_000));
const MAX_PENDING = Math.max(1, Number(process.env.SNIPER_MAX_PENDING || 20));
const MAX_ATTEMPTS_PER_TICK = Math.max(1, Number(process.env.SNIPER_MAX_ATTEMPTS_PER_TICK || 1));
const MAX_IMMEDIATE_ROUND_TRIP_LOSS_PCT = Math.min(-0.1, Number(process.env.SNIPER_MAX_IMMEDIATE_ROUND_TRIP_LOSS_PCT || -3));
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";

const BLOCKED_MINTS = new Set([
  JUPITER_SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const BLOCKED_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT", "USD"]);

type Candidate = {
  mint: string;
  signature: string;
  detectedAt: number;
  attempts: number;
  source: string;
  nextAttemptAt: number;
};

const seen = new Map<string, number>();
const pending = new Map<string, Candidate>();
let processing = false;
let lastDetectionAlertAt = 0;
let detectionsSinceHeartbeat = 0;
let entriesSinceHeartbeat = 0;
let subscriptionIds: number[] = [];
let nextJupiterRequestAt = 0;
let globalJupiterBackoffUntil = 0;
let jupiter429SinceHeartbeat = 0;

function rpcUrl() { const key = process.env.HELIUS_API_KEY?.trim() || ""; return process.env.HELIUS_RPC_URL?.trim() || `https://mainnet.helius-rpc.com/?api-key=${key}`; }
function wsUrl() { const key = process.env.HELIUS_API_KEY?.trim() || ""; return process.env.HELIUS_WS_URL?.trim() || `wss://mainnet.helius-rpc.com/?api-key=${key}`; }
function lamports(sol: number) { return String(Math.floor(sol * 1_000_000_000)); }
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isRateLimitError(error: unknown) { return /jupiter_quote_http_429|rate limit exceeded/i.test(error instanceof Error ? error.message : String(error)); }
async function telegram(message: string) { try { await sendTelegramAlert(message, { forceOperational: true }); } catch (error) { console.warn("[helius-sniper] Telegram alert failed", error); } }

async function audit(kind: string, mint: string | null, message: string, selected = false) {
  const now = new Date().toISOString();
  await supabase.from("scalp_scan_runs").insert({ started_at: now, finished_at: now, status: "ok", scanned_count: 1, qualified_count: selected ? 1 : 0, top_symbol: mint ? mint.slice(0, 8) : null, top_mint: mint, top_score: null, selected_mint: selected ? mint : null, message: `${kind}:${message}`, top_snapshot: { source: "helius_websocket", kind }, created_at: now });
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
  const pair = (Array.isArray(body) ? body : []).filter((p) => p?.chainId === "solana" && p?.baseToken?.address === mint && Number(p?.priceUsd || 0) > 0).sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];
  return pair ? { address: String(pair.pairAddress), priceUsd: Number(pair.priceUsd), symbol: String(pair.baseToken?.symbol || mint.slice(0, 8)) } : null;
}

async function waitForJupiterSlot() {
  const waitUntil = Math.max(nextJupiterRequestAt, globalJupiterBackoffUntil);
  const delay = waitUntil - Date.now();
  if (delay > 0) await sleep(delay);
  nextJupiterRequestAt = Date.now() + JUPITER_MIN_INTERVAL_MS;
}

async function quote(params: Parameters<typeof getJupiterQuote>[0]) {
  await waitForJupiterSlot();
  return getJupiterQuote(params);
}

async function reject(item: Candidate, reason: string) {
  pending.delete(item.mint);
  await audit("rejected", item.mint, reason);
  console.log(`[helius-sniper] REJECT mint=${item.mint} reason=${reason}`);
  return false;
}

async function attempt(item: Candidate) {
  const latencyBeforeQuote = Date.now() - item.detectedAt;
  if (latencyBeforeQuote > TTL_MS) return reject(item, `stale_before_quote_ms=${latencyBeforeQuote}`);
  if (BLOCKED_MINTS.has(item.mint)) return reject(item, "blocked_mint");

  const tradeInputSol = SIZE_SOL - legOverheadSol();
  if (tradeInputSol <= 0) throw new Error("position_size_below_entry_transaction_cost");

  const buy = await quote({ inputMint: JUPITER_SOL_MINT, outputMint: item.mint, rawTokenAmount: lamports(tradeInputSol), slippageBps: SLIPPAGE_BPS });
  if (!buy.route || buy.outLamports <= 0n) return false;
  if (String((buy.raw as any)?.outputMint || "") !== item.mint) return reject(item, "jupiter_output_mint_mismatch");

  const conservativeTokens = conservativeQuoteOutputRaw(buy);
  if (conservativeTokens <= 0n) return false;

  const sell = await quote({ inputMint: item.mint, outputMint: JUPITER_SOL_MINT, rawTokenAmount: conservativeTokens.toString(), slippageBps: SLIPPAGE_BPS });
  if (!sell.route || sell.outLamports <= 0n) return false;
  if (String((sell.raw as any)?.inputMint || "") !== item.mint || String((sell.raw as any)?.outputMint || "") !== JUPITER_SOL_MINT) {
    return reject(item, "jupiter_round_trip_mint_mismatch");
  }

  const latencyAfterQuotes = Date.now() - item.detectedAt;
  if (latencyAfterQuotes > TTL_MS) return reject(item, `stale_after_quotes_ms=${latencyAfterQuotes}`);

  const roundTripNetSol = conservativeSolProceeds(sell);
  const immediateRoundTripNetPct = ((roundTripNetSol / SIZE_SOL) - 1) * 100;
  if (immediateRoundTripNetPct < MAX_IMMEDIATE_ROUND_TRIP_LOSS_PCT) {
    return reject(item, `round_trip_cost_pct=${immediateRoundTripNetPct.toFixed(3)};floor=${MAX_IMMEDIATE_ROUND_TRIP_LOSS_PCT.toFixed(3)}`);
  }

  const pair = await pairFor(item.mint);
  if (!pair) return false;
  const normalizedSymbol = pair.symbol.trim().toUpperCase();
  if (BLOCKED_SYMBOLS.has(normalizedSymbol)) return reject(item, `blocked_symbol=${normalizedSymbol}`);

  const now = new Date().toISOString();
  const latency = Date.now() - item.detectedAt;
  if (latency > TTL_MS) return reject(item, `stale_before_open_ms=${latency}`);

  const snapshot = {
    source: "helius_websocket", launch_source: item.source, detection_signature: item.signature,
    detected_at: new Date(item.detectedAt).toISOString(), detection_to_entry_ms: latency,
    attempts: item.attempts, capital_debited_sol: SIZE_SOL, swap_input_sol: tradeInputSol,
    token_raw_amount: conservativeTokens.toString(), slippage_bps: SLIPPAGE_BPS,
    jupiter_buy: buy.raw, jupiter_sell_check: sell.raw,
    entry_costs: routeFeeSummary(buy.raw), exit_preview_costs: routeFeeSummary(sell.raw),
    immediate_round_trip_net_sol: roundTripNetSol,
    immediate_round_trip_net_pct: immediateRoundTripNetPct,
    entry_cost_gate_pct: MAX_IMMEDIATE_ROUND_TRIP_LOSS_PCT,
    simulation_policy: "Jupiter worst-case threshold plus route-change, partial-fill, network, priority and Jito penalties",
    paper_only: true,
  };
  const { error } = await supabase.rpc("open_paper_scalp", { p_position_id: randomUUID(), p_mint: item.mint, p_token_symbol: pair.symbol, p_pair_address: pair.address, p_entry_price_usd: pair.priceUsd, p_entry_time: now, p_size_sol: SIZE_SOL, p_entry_snapshot: snapshot });
  if (error) { if (/already open|daily entry|disabled|halted|insufficient/i.test(error.message)) return false; throw error; }
  entriesSinceHeartbeat += 1;
  await audit("entered", item.mint, `latency_ms=${latency};attempts=${item.attempts};round_trip_net=${roundTripNetSol.toFixed(6)}`, true);
  await telegram(`✅ <b>PAPER SNIPER OPENED</b>\n\n🪙 <b>${pair.symbol}</b>\nSize: <b>${SIZE_SOL.toFixed(3)} SOL</b>\nSource: <b>${item.source}</b>\nDetection → entry: <b>${latency} ms</b>\nJupiter attempts: <b>${item.attempts}</b>\nWorst-case immediate round trip: <b>${roundTripNetSol.toFixed(6)} SOL</b>\nEstimated immediate cost: <b>${((1 - roundTripNetSol / SIZE_SOL) * 100).toFixed(2)}%</b>\n\nMint:\n<code>${item.mint}</code>`);
  console.log(`[helius-sniper] ENTER ${pair.symbol} ${item.mint} latency=${latency}ms netRoundTrip=${roundTripNetSol.toFixed(6)}`);
  return true;
}

async function processQueue() {
  if (processing || Date.now() < globalJupiterBackoffUntil) return;
  processing = true;
  try {
    const now = Date.now();
    const candidates = [...pending.values()]
      .filter((item) => item.nextAttemptAt <= now)
      .sort((a, b) => b.detectedAt - a.detectedAt)
      .slice(0, MAX_ATTEMPTS_PER_TICK);

    for (const item of candidates) {
      if (Date.now() - item.detectedAt > TTL_MS) {
        pending.delete(item.mint);
        await audit("expired", item.mint, `no_executable_round_trip_within_ms=${TTL_MS}`);
        continue;
      }
      item.attempts += 1;
      item.nextAttemptAt = Date.now() + Math.min(2_000, RETRY_MS * Math.max(1, item.attempts));
      try {
        if (await attempt(item)) pending.delete(item.mint);
      } catch (error) {
        if (isRateLimitError(error)) {
          jupiter429SinceHeartbeat += 1;
          globalJupiterBackoffUntil = Date.now() + JUPITER_429_BACKOFF_MS;
          console.warn(`[helius-sniper] Jupiter 429; backing off ${JUPITER_429_BACKOFF_MS}ms pending=${pending.size}`);
          break;
        }
        console.warn(`[helius-sniper] route attempt failed mint=${item.mint}`, error);
      }
    }
  } finally {
    processing = false;
  }
}

function trimPendingForNewest() {
  if (pending.size < MAX_PENDING) return;
  const oldest = [...pending.values()].sort((a, b) => a.detectedAt - b.detectedAt)[0];
  if (oldest) pending.delete(oldest.mint);
}

function subscribe(connection: Connection, program: PublicKey, source: string) {
  return connection.onLogs(program, async ({ signature, err, logs }) => {
    if (err || !logs.some((line) => /Instruction: (Create|CreateV2|CreatePool)/i.test(line))) return;
    const detectedAt = Date.now();
    try {
      const mint = await extractMint(connection, signature);
      if (!mint || seen.has(mint) || BLOCKED_MINTS.has(mint)) return;
      seen.set(mint, detectedAt);
      trimPendingForNewest();
      pending.set(mint, { mint, signature, detectedAt, attempts: 0, source, nextAttemptAt: detectedAt });
      detectionsSinceHeartbeat += 1;
      await audit("detected", mint, `source=${source};signature=${signature}`);
      if (Date.now() - lastDetectionAlertAt >= DETECTION_ALERT_MIN_MS) {
        lastDetectionAlertAt = Date.now();
        void telegram(`🚀 <b>SNIPER LAUNCH DETECTED</b>\n\nSource: <b>${source}</b>\nMint:\n<code>${mint}</code>\n\nJupiter queue active; newest launches are prioritized.`);
      }
      void processQueue();
    } catch (error) { console.warn(`[helius-sniper] parse failed ${signature}`, error); }
  }, "confirmed");
}

export function startHeliusMillisecondSniper() {
  if (["0", "false", "off"].includes(String(process.env.ENABLE_HELIUS_MILLISECOND_SNIPER || "true").toLowerCase())) return;
  if (!process.env.HELIUS_API_KEY && !process.env.HELIUS_RPC_URL) throw new Error("HELIUS_API_KEY_or_HELIUS_RPC_URL_missing");
  const connection = new Connection(rpcUrl(), { commitment: "confirmed", wsEndpoint: wsUrl(), disableRetryOnRateLimit: false });
  Promise.all([subscribe(connection, PUMP_PROGRAM, "pump_create"), subscribe(connection, PUMPSWAP_PROGRAM, "pumpswap_pool")])
    .then((ids) => {
      subscriptionIds = ids;
      console.log(`[helius-sniper] ACTIVE subscriptions=${ids.join(",")} retry=${RETRY_MS}ms jupiterMinInterval=${JUPITER_MIN_INTERVAL_MS}ms maxPending=${MAX_PENDING} ttlMs=${TTL_MS} costFloorPct=${MAX_IMMEDIATE_ROUND_TRIP_LOSS_PCT} liveCostSimulation=true`);
      void telegram(`🟢 <b>HELIUS SNIPER ONLINE</b>\n\nSubscriptions: <b>${ids.length}</b>\nJupiter minimum interval: <b>${JUPITER_MIN_INTERVAL_MS} ms</b>\nCandidate TTL: <b>${(TTL_MS / 1000).toFixed(1)} sec</b>\nMax immediate cost: <b>${Math.abs(MAX_IMMEDIATE_ROUND_TRIP_LOSS_PCT).toFixed(1)}%</b>\nMax pending: <b>${MAX_PENDING}</b>\nPosition size: <b>${SIZE_SOL.toFixed(3)} SOL paper</b>\nLive-cost simulation: <b>ON</b>`);
    })
    .catch((error) => {
      console.error("[helius-sniper] websocket subscription failed", error);
      void telegram(`🚨 <b>HELIUS SNIPER CONNECTION FAILED</b>\n\n${error instanceof Error ? error.message : String(error)}\n\nRailway restart/reconnect required.`);
    });
  setInterval(() => void processQueue(), RETRY_MS);
  setInterval(() => {
    const backoffSeconds = Math.max(0, Math.ceil((globalJupiterBackoffUntil - Date.now()) / 1000));
    void telegram(`💓 <b>HELIUS SNIPER HEARTBEAT</b>\n\nStatus: <b>${subscriptionIds.length ? "CONNECTED" : "STARTING / DISCONNECTED"}</b>\nSubscriptions: <b>${subscriptionIds.length}</b>\nLaunches detected: <b>${detectionsSinceHeartbeat}</b>\nEntries opened: <b>${entriesSinceHeartbeat}</b>\nPending candidates: <b>${pending.size}</b>\nJupiter 429s: <b>${jupiter429SinceHeartbeat}</b>\nCurrent backoff: <b>${backoffSeconds} sec</b>`);
    detectionsSinceHeartbeat = 0;
    entriesSinceHeartbeat = 0;
    jupiter429SinceHeartbeat = 0;
  }, HEARTBEAT_MS);
  setInterval(() => { const cutoff = Date.now() - 3_600_000; for (const [mint, at] of seen) if (at < cutoff) seen.delete(mint); }, 60_000);
}
