import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";

const RPC_URL = required("HELIUS_RPC_URL");
const JUPITER_API_KEY = required("JUPITER_API_KEY");
const JUPITER_BASE = process.env.JUPITER_API_BASE ?? "https://api.jup.ag/swap/v1";
const SLIPPAGE_BPS = boundedInt("JUPITER_SLIPPAGE_BPS", 50, 1, 300);
const MAX_PRIORITY_FEE_LAMPORTS = boundedInt(
  "MAX_PRIORITY_FEE_LAMPORTS",
  500_000,
  1_000,
  5_000_000
);
const CONFIRM_TIMEOUT_MS = boundedInt("CONFIRMATION_TIMEOUT_MS", 45_000, 5_000, 120_000);

const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: CONFIRM_TIMEOUT_MS,
});
const wallet = loadKeypair();

export type SwapResult = {
  signature: string;
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  expectedOutputRaw: string;
  minimumOutputRaw: string;
  priceImpactPct: number;
  routeLabels: string[];
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function loadKeypair(): Keypair {
  const raw = required("SOLANA_PRIVATE_KEY");
  try {
    if (raw.startsWith("[")) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not_array");
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (error) {
    throw new Error(`Invalid SOLANA_PRIVATE_KEY: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function jupiterFetch(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${JUPITER_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": JUPITER_API_KEY,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`jupiter_http_${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

export function getWalletPublicKey(): string {
  return wallet.publicKey.toBase58();
}

export async function getQuote(inputMint: string, outputMint: string, amountRaw: string): Promise<any> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw,
    slippageBps: String(SLIPPAGE_BPS),
    restrictIntermediateTokens: "true",
    instructionVersion: "V2",
  });
  const quote = await jupiterFetch(`/quote?${params.toString()}`);
  if (!quote?.outAmount || BigInt(quote.outAmount) <= 0n) throw new Error("jupiter_quote_unavailable");
  return quote;
}

export async function executeExactInSwap(inputMint: string, outputMint: string, amountRaw: string): Promise<SwapResult> {
  new PublicKey(inputMint);
  new PublicKey(outputMint);
  if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) throw new Error("invalid_swap_amount");

  const quote = await getQuote(inputMint, outputMint, amountRaw);
  const swap = await jupiterFetch("/swap", {
    method: "POST",
    body: JSON.stringify({
      userPublicKey: wallet.publicKey.toBase58(),
      quoteResponse: quote,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: "veryHigh",
          maxLamports: MAX_PRIORITY_FEE_LAMPORTS,
        },
      },
    }),
  });

  if (!swap?.swapTransaction) throw new Error("jupiter_swap_transaction_missing");
  const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  transaction.sign([wallet]);

  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "processed",
    replaceRecentBlockhash: true,
  });
  if (simulation.value.err) {
    throw new Error(`swap_simulation_failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: transaction.message.recentBlockhash,
      lastValidBlockHeight: Number(swap.lastValidBlockHeight),
    },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(`swap_confirmation_failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return {
    signature,
    inputMint,
    outputMint,
    inputAmountRaw: amountRaw,
    expectedOutputRaw: String(quote.outAmount),
    minimumOutputRaw: String(quote.otherAmountThreshold ?? quote.outAmount),
    priceImpactPct: Number(quote.priceImpactPct ?? 0),
    routeLabels: Array.isArray(quote.routePlan)
      ? quote.routePlan.map((step: any) => String(step?.swapInfo?.label ?? "unknown"))
      : [],
  };
}

export async function getTokenBalanceRaw(mint: string): Promise<{ amountRaw: string; decimals: number }> {
  const result = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
    mint: new PublicKey(mint),
  });
  let total = 0n;
  let decimals = 0;
  for (const item of result.value) {
    const info = (item.account.data as any)?.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!tokenAmount?.amount) continue;
    total += BigInt(tokenAmount.amount);
    decimals = Number(tokenAmount.decimals ?? decimals);
  }
  return { amountRaw: total.toString(), decimals };
}
