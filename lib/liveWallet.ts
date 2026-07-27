import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || "";
const JUPITER_BASE = (process.env.JUPITER_API_BASE_URL?.trim() || (JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1")).replace(/\/$/, "");
const JUPITER_QUOTE = `${JUPITER_BASE}/quote`;
const JUPITER_SWAP = `${JUPITER_BASE}/swap`;
export const SOL_MINT = "So11111111111111111111111111111111111111112";

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
  const quoteUrl = new URL(JUPITER_QUOTE);
  quoteUrl.searchParams.set("inputMint", input.inputMint);
  quoteUrl.searchParams.set("outputMint", input.outputMint);
  quoteUrl.searchParams.set("amount", input.rawAmount);
  quoteUrl.searchParams.set("slippageBps", String(input.slippageBps));
  quoteUrl.searchParams.set("restrictIntermediateTokens", "true");

  let quoteResponse: Response;
  try {
    quoteResponse = await fetch(quoteUrl, { cache: "no-store", headers: jupiterHeaders() });
  } catch (cause) {
    throw new Error(`Jupiter quote network failure at ${quoteUrl.origin}: ${errorDetails(cause)}`);
  }
  if (!quoteResponse.ok) throw new Error(`Jupiter quote failed (${quoteResponse.status}): ${await responseError(quoteResponse)}`);
  const quote = await quoteResponse.json();
  if (!quote?.outAmount || BigInt(String(quote.outAmount)) <= 0n) throw new Error("Jupiter returned an empty quote");

  let swapResponse: Response;
  try {
    swapResponse = await fetch(JUPITER_SWAP, {
      method: "POST",
      headers: jupiterHeaders(true),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });
  } catch (cause) {
    throw new Error(`Jupiter swap network failure at ${new URL(JUPITER_SWAP).origin}: ${errorDetails(cause)}`);
  }
  if (!swapResponse.ok) throw new Error(`Jupiter swap build failed (${swapResponse.status}): ${await responseError(swapResponse)}`);
  const swap = await swapResponse.json();
  if (!swap.swapTransaction) throw new Error("Jupiter returned no swap transaction");

  const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  transaction.sign([signer]);
  const connection = getLiveConnection();
  const latest = await connection.getLatestBlockhash("confirmed");
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3, skipPreflight: false });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
  if (status.value?.err) throw new Error(`Confirmed transaction has an error: ${JSON.stringify(status.value.err)}`);
  return { signature, quote };
}

export async function executeJupiterBuy(input: { outputMint: string; lamports: number; slippageBps: number }) {
  if (!Number.isSafeInteger(input.lamports) || input.lamports <= 0) throw new Error("Invalid lamport amount");
  return executeJupiterSwap({ inputMint: SOL_MINT, outputMint: input.outputMint, rawAmount: String(input.lamports), slippageBps: input.slippageBps });
}

export async function executeJupiterSell(input: { inputMint: string; rawTokenAmount: string; slippageBps: number }) {
  return executeJupiterSwap({ inputMint: input.inputMint, outputMint: SOL_MINT, rawAmount: input.rawTokenAmount, slippageBps: input.slippageBps });
}
