import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

const JUPITER_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP = "https://quote-api.jup.ag/v6/swap";
const SOL_MINT = "So11111111111111111111111111111111111111112";

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
      error = cause instanceof Error ? cause.message : "Wallet balance lookup failed";
    }
  }
  return { rpcConfigured: Boolean(rpcUrl), publicKey, signerConfigured, armed, enabled, balanceSol, error };
}

export async function executeJupiterBuy(input: {
  outputMint: string;
  lamports: number;
  slippageBps: number;
}) {
  if (process.env.LIVE_TRADING_ENABLED !== "true" || process.env.LIVE_EXECUTION_ARMED !== "true") {
    throw new Error("Live execution is not enabled and armed");
  }
  const rpcUrl = getRpcUrl();
  if (!rpcUrl) throw new Error("Solana RPC is not configured");
  if (!Number.isInteger(input.lamports) || input.lamports <= 0) throw new Error("Invalid lamport amount");
  if (input.slippageBps < 10 || input.slippageBps > 500) throw new Error("Slippage must be 10-500 bps");

  const signer = getLiveSigner();
  const quoteUrl = new URL(JUPITER_QUOTE);
  quoteUrl.searchParams.set("inputMint", SOL_MINT);
  quoteUrl.searchParams.set("outputMint", input.outputMint);
  quoteUrl.searchParams.set("amount", String(input.lamports));
  quoteUrl.searchParams.set("slippageBps", String(input.slippageBps));
  const quoteResponse = await fetch(quoteUrl, { cache: "no-store" });
  if (!quoteResponse.ok) throw new Error(`Jupiter quote failed (${quoteResponse.status})`);
  const quote = await quoteResponse.json();

  const swapResponse = await fetch(JUPITER_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: signer.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  });
  if (!swapResponse.ok) throw new Error(`Jupiter swap build failed (${swapResponse.status})`);
  const swap = await swapResponse.json();
  if (!swap.swapTransaction) throw new Error("Jupiter returned no swap transaction");

  const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  transaction.sign([signer]);
  const connection = new Connection(rpcUrl, "confirmed");
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3, skipPreflight: false });
  const confirmation = await connection.confirmTransaction(signature, "confirmed");
  if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return { signature, quote };
}
