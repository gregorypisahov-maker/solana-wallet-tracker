import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { PublicKey } from "@solana/web3.js";
import {
  executeUsdcToTokenSwap,
  getTradingWalletPublicKey,
  type SwapExecutionResult,
} from "./jupiterExecutor";

const PORT = Number(process.env.PORT ?? 3000);
const WEBHOOK_PATH = process.env.HELIUS_WEBHOOK_PATH ?? "/webhooks/helius";
const HELIUS_WEBHOOK_AUTH_HEADER = required("HELIUS_WEBHOOK_AUTH_HEADER");
const BOT_EXECUTION_ENABLED = process.env.BOT_EXECUTION_ENABLED === "true";
const USDC_MINT =
  process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT =
  process.env.WSOL_MINT ?? "So11111111111111111111111111111111111111112";
const MAX_BODY_BYTES = process.env.MAX_WEBHOOK_BODY_BYTES ?? "2mb";
const MAX_QUEUE_DEPTH = positiveInt("MAX_QUEUE_DEPTH", 100);
const RECENT_SIGNATURE_LIMIT = positiveInt("RECENT_SIGNATURE_LIMIT", 10_000);
const TRADE_COOLDOWN_MS = positiveInt("TRADE_COOLDOWN_MS", 30_000);

type RawTokenAmount = { tokenAmount?: string; decimals?: number };
type HeliusTokenBalanceChange = {
  userAccount?: string;
  tokenAccount?: string;
  mint?: string;
  rawTokenAmount?: RawTokenAmount;
};
type HeliusEnhancedTransaction = {
  type?: string;
  source?: string;
  signature?: string;
  slot?: number;
  timestamp?: number;
  transactionError?: unknown;
  tokenTransfers?: Array<{
    mint?: string;
    tokenAmount?: number;
    fromUserAccount?: string;
    toUserAccount?: string;
    fromTokenAccount?: string;
    toTokenAccount?: string;
  }>;
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: HeliusTokenBalanceChange[];
  }>;
  instructions?: Array<{
    programId?: string;
    accounts?: string[];
    innerInstructions?: Array<{ programId?: string; accounts?: string[] }>;
  }>;
  events?: {
    swap?: {
      nativeInput?: { account?: string; amount?: string };
      nativeOutput?: { account?: string; amount?: string };
      tokenInputs?: Array<{
        userAccount?: string;
        tokenAccount?: string;
        mint?: string;
        rawTokenAmount?: RawTokenAmount;
      }>;
      tokenOutputs?: Array<{
        userAccount?: string;
        tokenAccount?: string;
        mint?: string;
        rawTokenAmount?: RawTokenAmount;
      }>;
      innerSwaps?: Array<{
        tokenInputs?: Array<{ mint?: string; fromTokenAccount?: string; toTokenAccount?: string }>;
        tokenOutputs?: Array<{ mint?: string; fromTokenAccount?: string; toTokenAccount?: string }>;
        programInfo?: {
          source?: string;
          account?: string;
          programName?: string;
          instructionName?: string;
        };
      }>;
    };
  };
};

type ParsedSwapSignal = {
  signature: string;
  source: string;
  targetMint: string;
  inputMints: string[];
  outputMints: string[];
  poolKeys: string[];
  liquidityDelta: {
    targetTokenRawDelta: string;
    targetTokenUiDelta: number | null;
    decimals: number | null;
    observedAccounts: string[];
    interpretation: string;
  };
};

type Activity = {
  at: string;
  signature: string;
  targetMint?: string;
  status: "received" | "ignored" | "queued" | "executed" | "failed";
  message: string;
  transactionSignature?: string;
};

const state = {
  startedAt: new Date().toISOString(),
  webhookCount: 0,
  acceptedSwapCount: 0,
  ignoredCount: 0,
  executedCount: 0,
  failedCount: 0,
  queueDepth: 0,
  processing: false,
  lastWebhookAt: null as string | null,
  lastTradeAt: null as string | null,
  lastError: null as string | null,
  activities: [] as Activity[],
};

const recentSignatures = new Map<string, number>();
const lastMintTradeAt = new Map<string, number>();
const queue: ParsedSwapSignal[] = [];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validPublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter(validPublicKey))];
}

function rawAmount(item: { rawTokenAmount?: RawTokenAmount } | undefined): bigint {
  const value = item?.rawTokenAmount?.tokenAmount;
  return typeof value === "string" && /^-?\d+$/.test(value) ? BigInt(value) : 0n;
}

function selectTargetMint(inputMints: string[], outputMints: string[]): string | null {
  const excluded = new Set([USDC_MINT, WSOL_MINT]);
  return (
    outputMints.find((mint) => !excluded.has(mint)) ??
    inputMints.find((mint) => !excluded.has(mint)) ??
    null
  );
}

function parseSwap(tx: HeliusEnhancedTransaction): ParsedSwapSignal | null {
  if (tx.type !== "SWAP" || tx.transactionError || !tx.signature) return null;
  const swap = tx.events?.swap;
  if (!swap) return null;

  const inputMints = unique([
    ...(swap.tokenInputs ?? []).map((item) => item.mint),
  ]);
  const outputMints = unique([
    ...(swap.tokenOutputs ?? []).map((item) => item.mint),
  ]);
  const targetMint = selectTargetMint(inputMints, outputMints);
  if (!targetMint) return null;

  const poolKeys = unique([
    ...(swap.innerSwaps ?? []).map((item) => item.programInfo?.account),
    ...(tx.instructions ?? []).flatMap((instruction) => [
      instruction.programId,
      ...(instruction.accounts ?? []),
      ...(instruction.innerInstructions ?? []).flatMap((inner) => [
        inner.programId,
        ...(inner.accounts ?? []),
      ]),
    ]),
  ]);

  let rawDelta = 0n;
  let decimals: number | null = null;
  const observedAccounts: string[] = [];
  for (const account of tx.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.mint !== targetMint) continue;
      rawDelta += rawAmount(change);
      if (Number.isInteger(change.rawTokenAmount?.decimals)) {
        decimals = change.rawTokenAmount!.decimals!;
      }
      if (account.account) observedAccounts.push(account.account);
      if (change.tokenAccount) observedAccounts.push(change.tokenAccount);
    }
  }

  const targetTokenUiDelta =
    decimals == null ? null : Number(rawDelta) / 10 ** decimals;

  return {
    signature: tx.signature,
    source: tx.source ?? "UNKNOWN",
    targetMint,
    inputMints,
    outputMints,
    poolKeys,
    liquidityDelta: {
      targetTokenRawDelta: rawDelta.toString(),
      targetTokenUiDelta: Number.isFinite(targetTokenUiDelta) ? targetTokenUiDelta : null,
      decimals,
      observedAccounts: unique(observedAccounts),
      interpretation:
        "Net target-mint balance change across accounts exposed by Helius. This is an observed flow signal, not a guaranteed full-pool TVL measurement.",
    },
  };
}

function rememberSignature(signature: string): boolean {
  if (recentSignatures.has(signature)) return false;
  recentSignatures.set(signature, Date.now());
  while (recentSignatures.size > RECENT_SIGNATURE_LIMIT) {
    const oldest = recentSignatures.keys().next().value as string | undefined;
    if (!oldest) break;
    recentSignatures.delete(oldest);
  }
  return true;
}

function addActivity(activity: Activity): void {
  state.activities.unshift(activity);
  state.activities.splice(50);
}

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`telegram_http_${response.status}: ${await response.text()}`);
  }
}

function enqueue(signal: ParsedSwapSignal): boolean {
  if (queue.length >= MAX_QUEUE_DEPTH) return false;
  queue.push(signal);
  state.queueDepth = queue.length;
  void drainQueue();
  return true;
}

async function drainQueue(): Promise<void> {
  if (state.processing) return;
  state.processing = true;
  try {
    while (queue.length > 0) {
      const signal = queue.shift()!;
      state.queueDepth = queue.length;
      await processSignal(signal);
    }
  } finally {
    state.processing = false;
  }
}

async function processSignal(signal: ParsedSwapSignal): Promise<void> {
  const now = Date.now();
  const last = lastMintTradeAt.get(signal.targetMint) ?? 0;
  if (now - last < TRADE_COOLDOWN_MS) {
    state.ignoredCount += 1;
    addActivity({
      at: new Date().toISOString(),
      signature: signal.signature,
      targetMint: signal.targetMint,
      status: "ignored",
      message: "Per-mint cooldown active",
    });
    return;
  }

  if (!BOT_EXECUTION_ENABLED) {
    addActivity({
      at: new Date().toISOString(),
      signature: signal.signature,
      targetMint: signal.targetMint,
      status: "queued",
      message: "Validated signal; live execution disabled",
    });
    await sendTelegram(
      `🟡 Single Bot signal\nMint: ${signal.targetMint}\nSource: ${signal.source}\nWebhook: ${signal.signature}\nExecution: DISABLED`
    ).catch((error) => {
      state.lastError = String(error);
    });
    return;
  }

  lastMintTradeAt.set(signal.targetMint, now);
  try {
    const result: SwapExecutionResult = await executeUsdcToTokenSwap(signal.targetMint);
    state.executedCount += 1;
    state.lastTradeAt = new Date().toISOString();
    state.lastError = null;
    addActivity({
      at: state.lastTradeAt,
      signature: signal.signature,
      targetMint: signal.targetMint,
      status: "executed",
      message: `USDC → token swap submitted via ${result.broadcastMode}`,
      transactionSignature: result.signature,
    });
    await sendTelegram(
      `🟢 Single Bot trade submitted\nMint: ${signal.targetMint}\nInput: ${result.inputAmountUi} USDC\nExpected output raw: ${result.expectedOutputRaw}\nPrice impact: ${result.priceImpactPct}%\nRoute: ${result.routeLabels.join(" → ") || "unknown"}\nTx: ${result.signature}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.failedCount += 1;
    state.lastError = message;
    addActivity({
      at: new Date().toISOString(),
      signature: signal.signature,
      targetMint: signal.targetMint,
      status: "failed",
      message,
    });
    await sendTelegram(
      `🔴 Single Bot trade failed\nMint: ${signal.targetMint}\nWebhook: ${signal.signature}\nError: ${message.slice(0, 800)}`
    ).catch(() => undefined);
  }
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: MAX_BODY_BYTES, type: ["application/json", "application/*+json"] }));

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "single-helius-jupiter-bot",
    executionEnabled: BOT_EXECUTION_ENABLED,
    wallet: getTradingWalletPublicKey(),
    ...state,
  });
});

app.get("/api/status", (_req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store");
  res.json({
    service: "single-helius-jupiter-bot",
    executionEnabled: BOT_EXECUTION_ENABLED,
    wallet: getTradingWalletPublicKey(),
    webhookPath: WEBHOOK_PATH,
    ...state,
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Single Solana Bot</title>
<style>
body{font-family:system-ui;background:#090d12;color:#eaf2ff;margin:0;padding:24px}.wrap{max-width:1000px;margin:auto}
h1{margin:0 0 6px}.muted{color:#9fb0c4}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:22px 0}
.card{background:#121923;border:1px solid #243144;border-radius:14px;padding:16px}.value{font-size:25px;font-weight:750;margin-top:7px}
.ok{color:#71e59a}.off{color:#ffcc66}.bad{color:#ff7b7b}table{width:100%;border-collapse:collapse;background:#121923;border-radius:14px;overflow:hidden}
th,td{text-align:left;padding:11px;border-bottom:1px solid #243144;font-size:13px}code{word-break:break-all;color:#b9d5ff}
</style></head><body><div class="wrap"><h1>Single Solana Bot</h1><div class="muted">Helius webhook → Jupiter execution → Telegram alerts</div>
<div id="app">Loading…</div></div>
<script>
async function refresh(){const s=await fetch('/api/status',{cache:'no-store'}).then(r=>r.json());
const cls=s.executionEnabled?'ok':'off'; const rows=(s.activities||[]).map(a=>'<tr><td>'+a.at+'</td><td>'+a.status+'</td><td><code>'+(a.targetMint||'—')+'</code></td><td>'+a.message+'</td></tr>').join('');
document.getElementById('app').innerHTML='<div class="grid">'+
'<div class="card"><div class="muted">Execution</div><div class="value '+cls+'">'+(s.executionEnabled?'LIVE':'DISABLED')+'</div></div>'+
'<div class="card"><div class="muted">Webhooks</div><div class="value">'+s.webhookCount+'</div></div>'+
'<div class="card"><div class="muted">Accepted swaps</div><div class="value">'+s.acceptedSwapCount+'</div></div>'+
'<div class="card"><div class="muted">Executed</div><div class="value">'+s.executedCount+'</div></div>'+
'<div class="card"><div class="muted">Failures</div><div class="value '+(s.failedCount?'bad':'')+'">'+s.failedCount+'</div></div>'+
'</div><div class="card"><div class="muted">Wallet</div><code>'+s.wallet+'</code><br><div class="muted" style="margin-top:8px">Last error</div><div>'+(s.lastError||'None')+'</div></div>'+
'<h2>Recent activity</h2><table><thead><tr><th>Time</th><th>Status</th><th>Mint</th><th>Message</th></tr></thead><tbody>'+rows+'</tbody></table>';
} refresh(); setInterval(refresh,3000);
</script></body></html>`);
});

app.post(WEBHOOK_PATH, (req: Request, res: Response) => {
  const supplied =
    req.get("authorization") ??
    req.get("x-helius-auth-token") ??
    "";
  if (!safeEqual(supplied, HELIUS_WEBHOOK_AUTH_HEADER)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const transactions: HeliusEnhancedTransaction[] = Array.isArray(req.body)
    ? req.body
    : [req.body];

  state.webhookCount += transactions.length;
  state.lastWebhookAt = new Date().toISOString();
  let accepted = 0;
  let duplicates = 0;
  let ignored = 0;
  let queueFull = 0;

  for (const tx of transactions) {
    if (!tx?.signature || !rememberSignature(tx.signature)) {
      duplicates += 1;
      continue;
    }
    const signal = parseSwap(tx);
    if (!signal) {
      ignored += 1;
      state.ignoredCount += 1;
      continue;
    }
    if (!enqueue(signal)) {
      queueFull += 1;
      continue;
    }
    accepted += 1;
    state.acceptedSwapCount += 1;
    addActivity({
      at: new Date().toISOString(),
      signature: signal.signature,
      targetMint: signal.targetMint,
      status: "received",
      message: `Validated ${signal.source} swap; ${signal.poolKeys.length} related keys extracted`,
    });
  }

  return res.status(queueFull > 0 ? 503 : 202).json({
    ok: queueFull === 0,
    accepted,
    duplicates,
    ignored,
    queueFull,
    executionEnabled: BOT_EXECUTION_ENABLED,
  });
});

app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  state.lastError = message;
  console.error("[single-bot] request error", error);
  res.status(400).json({ ok: false, error: "invalid_request" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[single-bot] listening on :${PORT}${WEBHOOK_PATH}`);
  console.log(`[single-bot] execution=${BOT_EXECUTION_ENABLED ? "LIVE" : "DISABLED"}`);
  console.log(`[single-bot] wallet=${getTradingWalletPublicKey()}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[single-bot] ${signal}; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  state.lastError = String(error);
  console.error("[single-bot] unhandled rejection", error);
});
