import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || "";
const JUPITER_BASE = (process.env.JUPITER_API_BASE_URL?.trim() || (JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1")).replace(/\/$/, "");
const JUPITER_QUOTE = `${JUPITER_BASE}/quote`;
const JUPITER_SWAP = `${JUPITER_BASE}/swap`;
const JUPITER_HTTP_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.JUPITER_HTTP_ATTEMPTS) || 3));
const JUPITER_HTTP_TIMEOUT_MS = Math.max(3_000, Number(process.env.JUPITER_HTTP_TIMEOUT_MS) || 12_000);
const JUPITER_BUILD_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.JUPITER_BUILD_ATTEMPTS) || 2));
const JUPITER_CONFIRM_TIMEOUT_MS = Math.max(30_000, Number(process.env.JUPITER_CONFIRM_TIMEOUT_MS) || 100_000);
const JUPITER_REBROADCAST_MS = Math.max(1_000, Number(process.env.JUPITER_REBROADCAST_MS) || 2_000);
const JUPITER_MAX_PRIORITY_FEE_LAMPORTS = Math.max(50_000, Number(process.env.JUPITER_MAX_PRIORITY_FEE_LAMPORTS) || 500_000);
const JUPITER_PRIORITY_LEVEL = ["medium", "high", "veryHigh"].includes(process.env.JUPITER_PRIORITY_LEVEL || "")
  ? process.env.JUPITER_PRIORITY_LEVEL
  : "veryHigh";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeBase58(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("LIVE_WALLET_PRIVATE_KEY is not valid base58");
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function encodeBase58(value: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (value.length === 0) return "";
  const digits = [0];
  for (const byte of value) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) leadingZeroes += 1;
  let result = "1".repeat(leadingZeroes);
  for (let i = digits.length - 1; i >= 0; i -= 1) result += alphabet[digits[i]];
  return result;
}

function errorDetails(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const nested = cause.cause;
  if (nested && typeof nested === "object") {
    const code = "code" in nested ? String(nested.code) : "";
    const message = "message" in nested ? String(nested.message) : "";
    if (code || message) return [cause.message, code, message].filter(Boolean).join(": ");
  }
  return cause.message;
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text ? text.slice(0, 500) : response.statusText;
}

function jupiterHeaders(json = false): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}),
  };
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchJupiter(endpoint: URL | string, init: RequestInit, label: string): Promise<Response> {
  const target = endpoint instanceof URL ? endpoint : new URL(endpoint);
  let lastError = `${label} failed`;
  for (let attempt = 1; attempt <= JUPITER_HTTP_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JUPITER_HTTP_TIMEOUT_MS);
    let response: Response | null = null;
    try {
      response = await fetch(target, { ...init, signal: controller.signal, cache: "no-store" });
    } catch (cause) {
      lastError = `${label} network failure at ${target.origin}: ${errorDetails(cause)}`;
    } finally {
      clearTimeout(timeout);
    }

    if (response?.ok) return response;
    if (response) {
      lastError = `${label} failed (${response.status}): ${await responseError(response)}`;
      if (!retryableHttpStatus(response.status)) throw new Error(lastError);
    }
    if (attempt < JUPITER_HTTP_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }
  throw new Error(lastError);
}

export function getRpcUrl(): string | null {
  return process.env.SOLANA_RPC_URL?.trim() || process.env.ALCHEMY_RPC_URL?.trim() || null;
}

export function getConfiguredPublicKey(): string | null {
  return process.env.LIVE_WALLET_PUBLIC_KEY?.trim() || null;
}

export function getLiveSigner(): Keypair {
  const raw = process.env.LIVE_WALLET_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("LIVE_WALLET_PRIVATE_KEY is missing");
  let secret: Uint8Array;
  if (raw.startsWith("[")) secret = Uint8Array.from(JSON.parse(raw));
  else if (raw.startsWith("base64:")) secret = Uint8Array.from(Buffer.from(raw.slice(7), "base64"));
  else secret = decodeBase58(raw);
  const keypair = Keypair.fromSecretKey(secret);
  const configured = getConfiguredPublicKey();
  if (configured && keypair.publicKey.toBase58() !== configured) {
    throw new Error("Private key does not match LIVE_WALLET_PUBLIC_KEY");
  }
  return keypair;
}

export function getLiveConnection(): Connection {
  const rpcUrl = getRpcUrl();
  if (!rpcUrl) throw new Error("Solana RPC is not configured");
  return new Connection(rpcUrl, "confirmed");
}

export async function getWalletSolLamports(): Promise<number> {
  const signer = getLiveSigner();
  return getLiveConnection().getBalance(signer.publicKey, "confirmed");
}

export async function getWalletTokenRawAmount(mint: string): Promise<bigint> {
  const signer = getLiveSigner();
  const connection = getLiveConnection();
  const accounts = await connection.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) }, "confirmed");
  return accounts.value.reduce((total, account) => {
    const amount = account.account.data.parsed?.info?.tokenAmount?.amount;
    return total + (typeof amount === "string" ? BigInt(amount) : 0n);
  }, 0n);
}

export async function getLiveWalletHealth() {
  const rpcUrl = getRpcUrl();
  const publicKey = getConfiguredPublicKey();
  const signerConfigured = Boolean(process.env.LIVE_WALLET_PRIVATE_KEY?.trim());
  const armed = process.env.LIVE_EXECUTION_ARMED === "true";
  const enabled = process.env.LIVE_TRADING_ENABLED === "true";
  let balanceSol: number | null = null;
  let error: string | null = null;
  if (rpcUrl && publicKey) {
    try {
      const connection = new Connection(rpcUrl, "confirmed");
      balanceSol = (await connection.getBalance(new PublicKey(publicKey))) / 1_000_000_000;
    } catch (cause) {
      error = errorDetails(cause);
    }
  }
  return { rpcConfigured: Boolean(rpcUrl), publicKey, signerConfigured, armed, enabled, balanceSol, error };
}

async function confirmedSignature(connection: Connection, signature: string): Promise<boolean> {
  const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = response.value[0];
  if (!status) return false;
  if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
  return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" || status.confirmations === null;
}

async function confirmJupiterTransaction(input: {
  connection: Connection;
  signature: string;
  transactionBinary: Uint8Array;
  lastValidBlockHeight: number;
}): Promise<void> {
  const startedAt = Date.now();
  let lastBroadcastAt = 0;
  let lastRpcError = "";

  while (Date.now() - startedAt < JUPITER_CONFIRM_TIMEOUT_MS) {
    try {
      if (await confirmedSignature(input.connection, input.signature)) return;
      lastRpcError = "";
    } catch (cause) {
      const message = errorDetails(cause);
      if (message.startsWith("Transaction failed:")) throw cause;
      lastRpcError = message;
    }

    try {
      const currentBlockHeight = await input.connection.getBlockHeight("confirmed");
      if (currentBlockHeight > input.lastValidBlockHeight) {
        const landed = await input.connection.getTransaction(input.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }).catch(() => null);
        if (landed?.meta?.err) throw new Error(`Transaction failed: ${JSON.stringify(landed.meta.err)}`);
        if (landed) return;
        throw new Error(`Jupiter transaction expired before confirmation: ${input.signature}`);
      }
    } catch (cause) {
      const message = errorDetails(cause);
      if (message.startsWith("Transaction failed:") || message.startsWith("Jupiter transaction expired")) throw cause;
      lastRpcError = message;
    }

    if (Date.now() - lastBroadcastAt >= JUPITER_REBROADCAST_MS) {
      lastBroadcastAt = Date.now();
      await input.connection.sendRawTransaction(input.transactionBinary, {
        maxRetries: 0,
        skipPreflight: true,
        preflightCommitment: "confirmed",
      }).catch((cause) => {
        lastRpcError = errorDetails(cause);
      });
    }
    await sleep(1_000);
  }

  if (await confirmedSignature(input.connection, input.signature).catch(() => false)) return;
  throw new Error(`Jupiter confirmation timed out for ${input.signature}${lastRpcError ? `: ${lastRpcError}` : ""}`);
}

function safeToRebuild(message: string): boolean {
  return /Jupiter (quote|swap build) (network failure|failed)|Jupiter transaction expired|blockhash not found|block height exceeded/i.test(message);
}

export async function executeJupiterSwap(input: {
  inputMint: string;
  outputMint: string;
  rawAmount: string;
  slippageBps: number;
}) {
  if (process.env.LIVE_TRADING_ENABLED !== "true" || process.env.LIVE_EXECUTION_ARMED !== "true") {
    throw new Error("Live execution is not enabled and armed");
  }
  if (!/^\d+$/.test(input.rawAmount) || BigInt(input.rawAmount) <= 0n) throw new Error("Invalid raw swap amount");
  if (input.slippageBps < 10 || input.slippageBps > 200) throw new Error("Slippage must be 10-200 bps");
  new PublicKey(input.inputMint);
  new PublicKey(input.outputMint);

  const signer = getLiveSigner();
  let lastError = "Jupiter swap failed";

  for (let buildAttempt = 1; buildAttempt <= JUPITER_BUILD_ATTEMPTS; buildAttempt += 1) {
    try {
      const quoteUrl = new URL(JUPITER_QUOTE);
      quoteUrl.searchParams.set("inputMint", input.inputMint);
      quoteUrl.searchParams.set("outputMint", input.outputMint);
      quoteUrl.searchParams.set("amount", input.rawAmount);
      quoteUrl.searchParams.set("slippageBps", String(input.slippageBps));
      quoteUrl.searchParams.set("restrictIntermediateTokens", "true");

      const quoteResponse = await fetchJupiter(quoteUrl, { headers: jupiterHeaders() }, "Jupiter quote");
      const quote = await quoteResponse.json();
      if (!quote?.outAmount || BigInt(String(quote.outAmount)) <= 0n) throw new Error("Jupiter returned an empty quote");

      const swapResponse = await fetchJupiter(JUPITER_SWAP, {
        method: "POST",
        headers: jupiterHeaders(true),
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: signer.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: JUPITER_MAX_PRIORITY_FEE_LAMPORTS,
              global: false,
              priorityLevel: JUPITER_PRIORITY_LEVEL,
            },
          },
        }),
      }, "Jupiter swap build");
      const swap = await swapResponse.json();
      if (swap?.simulationError) throw new Error(`Jupiter swap simulation failed: ${JSON.stringify(swap.simulationError)}`);
      if (!swap?.swapTransaction) throw new Error("Jupiter returned no swap transaction");
      const lastValidBlockHeight = Number(swap.lastValidBlockHeight);
      if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
        throw new Error("Jupiter returned no valid lastValidBlockHeight");
      }

      const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
      transaction.sign([signer]);
      const transactionBinary = transaction.serialize();
      const expectedSignature = encodeBase58(transaction.signatures[0]);
      const connection = getLiveConnection();

      let signature: string;
      try {
        signature = await connection.sendRawTransaction(transactionBinary, {
          maxRetries: 0,
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
      } catch (cause) {
        const message = errorDetails(cause);
        if (/blockhash not found|block height exceeded/i.test(message)) throw new Error(message);
        if (/simulation failed|insufficient funds|custom program error|slippage/i.test(message)) {
          throw new Error(`Solana preflight failed: ${message}`);
        }
        const landed = await confirmedSignature(connection, expectedSignature).catch(() => false);
        if (landed) return { signature: expectedSignature, quote };
        throw new Error(`Solana transaction submission failed: ${message}`);
      }

      await confirmJupiterTransaction({ connection, signature, transactionBinary, lastValidBlockHeight });
      return { signature, quote };
    } catch (cause) {
      lastError = errorDetails(cause);
      if (buildAttempt >= JUPITER_BUILD_ATTEMPTS || !safeToRebuild(lastError)) throw new Error(lastError);
      await sleep(500 * buildAttempt);
    }
  }

  throw new Error(lastError);
}

export async function executeJupiterBuy(input: { outputMint: string; lamports: number; slippageBps: number }) {
  if (!Number.isSafeInteger(input.lamports) || input.lamports <= 0) throw new Error("Invalid lamport amount");
  return executeJupiterSwap({ inputMint: SOL_MINT, outputMint: input.outputMint, rawAmount: String(input.lamports), slippageBps: input.slippageBps });
}

export async function executeJupiterSell(input: { inputMint: string; rawTokenAmount: string; slippageBps: number }) {
  return executeJupiterSwap({ inputMint: input.inputMint, outputMint: SOL_MINT, rawAmount: input.rawTokenAmount, slippageBps: input.slippageBps });
}
