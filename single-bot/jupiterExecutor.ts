import bs58 from "bs58";
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createJupiterApiClient,
  type QuoteResponse,
} from "@jup-ag/api";

const USDC_MINT =
  process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
const RPC_URL = required("HELIUS_RPC_URL");
const JUPITER_API_BASE =
  process.env.JUPITER_API_BASE ?? "https://api.jup.ag/swap/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim();
const INPUT_USDC_UI = positiveNumber("TRADE_SIZE_USDC", 5);
const SLIPPAGE_BPS = boundedInt("JUPITER_SLIPPAGE_BPS", 50, 1, 500);
const MAX_PRICE_IMPACT_PCT = positiveNumber("MAX_PRICE_IMPACT_PCT", 2);
const MAX_PRIORITY_FEE_LAMPORTS = boundedInt(
  "MAX_PRIORITY_FEE_LAMPORTS",
  500_000,
  1_000,
  10_000_000
);
const JITO_TIP_LAMPORTS = boundedInt(
  "JITO_TIP_LAMPORTS",
  10_000,
  1_000,
  10_000_000
);
const BROADCAST_MODE =
  process.env.BROADCAST_MODE === "jito" ? "jito" : "helius";
const JITO_URL =
  process.env.JITO_URL ??
  "https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true";
const JITO_AUTH_UUID = process.env.JITO_AUTH_UUID?.trim();
const CONFIRMATION_TIMEOUT_MS = boundedInt(
  "CONFIRMATION_TIMEOUT_MS",
  45_000,
  5_000,
  120_000
);

const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: CONFIRMATION_TIMEOUT_MS,
});
const wallet = loadKeypair();

const jupiter = createJupiterApiClient({
  basePath: JUPITER_API_BASE,
  fetchApi: async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (JUPITER_API_KEY) headers.set("x-api-key", JUPITER_API_KEY);
    return fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  },
});

export type SwapExecutionResult = {
  signature: string;
  broadcastMode: "helius" | "jito";
  targetMint: string;
  inputAmountUi: number;
  expectedOutputRaw: string;
  minimumOutputRaw: string;
  priceImpactPct: number;
  routeLabels: string[];
  lastValidBlockHeight: number;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedInt(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(process.env[name]);
  const parsed = Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function loadKeypair(): Keypair {
  const secret = required("SOLANA_PRIVATE_KEY");
  try {
    if (secret.startsWith("[")) {
      const bytes = Uint8Array.from(JSON.parse(secret) as number[]);
      if (bytes.length !== 64) throw new Error("JSON key must contain 64 bytes");
      return Keypair.fromSecretKey(bytes);
    }
    const bytes = bs58.decode(secret);
    if (bytes.length !== 64) throw new Error("base58 key must decode to 64 bytes");
    return Keypair.fromSecretKey(bytes);
  } catch (error) {
    throw new Error(
      `Invalid SOLANA_PRIVATE_KEY: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function getTradingWalletPublicKey(): string {
  return wallet.publicKey.toBase58();
}

function usdcRawAmount(uiAmount: number): number {
  const raw = Math.round(uiAmount * 10 ** USDC_DECIMALS);
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error("TRADE_SIZE_USDC cannot be represented safely");
  }
  return raw;
}

async function getQuote(targetMint: string): Promise<QuoteResponse> {
  const quote = await jupiter.quoteGet({
    inputMint: USDC_MINT,
    outputMint: targetMint,
    amount: usdcRawAmount(INPUT_USDC_UI),
    slippageBps: SLIPPAGE_BPS,
    swapMode: "ExactIn",
    restrictIntermediateTokens: true,
    onlyDirectRoutes: false,
    asLegacyTransaction: false,
  });

  if (!quote?.outAmount || BigInt(quote.outAmount) <= 0n) {
    throw new Error("Jupiter returned an empty quote");
  }
  const impact = Number(quote.priceImpactPct ?? "0");
  if (!Number.isFinite(impact)) throw new Error("Invalid Jupiter price impact");
  if (impact > MAX_PRICE_IMPACT_PCT) {
    throw new Error(
      `Price impact ${impact.toFixed(4)}% exceeds ${MAX_PRICE_IMPACT_PCT}%`
    );
  }
  return quote;
}

async function buildSignedTransaction(
  quoteResponse: QuoteResponse
): Promise<{
  transaction: VersionedTransaction;
  serialized: Uint8Array;
  lastValidBlockHeight: number;
}> {
  const prioritizationFeeLamports =
    BROADCAST_MODE === "jito"
      ? { jitoTipLamports: JITO_TIP_LAMPORTS }
      : {
          priorityLevelWithMaxLamports: {
            priorityLevel: "veryHigh" as const,
            maxLamports: MAX_PRIORITY_FEE_LAMPORTS,
            global: false,
          },
        };

  const swap = await jupiter.swapPost({
    swapRequest: {
      userPublicKey: wallet.publicKey.toBase58(),
      quoteResponse,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports,
      asLegacyTransaction: false,
    },
  });

  if (!swap.swapTransaction) {
    throw new Error("Jupiter did not return a serialized transaction");
  }

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(swap.swapTransaction, "base64")
  );
  transaction.sign([wallet]);
  const serialized = transaction.serialize();

  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "processed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.slice(-8).join(" | ") ?? "no logs";
    throw new Error(
      `Simulation failed: ${JSON.stringify(simulation.value.err)}; ${logs}`
    );
  }

  return {
    transaction,
    serialized,
    lastValidBlockHeight: swap.lastValidBlockHeight,
  };
}

async function broadcastViaHelius(
  serialized: Uint8Array,
  transaction: VersionedTransaction,
  lastValidBlockHeight: number
): Promise<string> {
  const signature = await connection.sendRawTransaction(serialized, {
    skipPreflight: true,
    maxRetries: 3,
    preflightCommitment: "processed",
  });
  const blockhash = transaction.message.recentBlockhash;
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(
      `Transaction ${signature} failed: ${JSON.stringify(
        confirmation.value.err
      )}`
    );
  }
  return signature;
}

async function broadcastViaJito(serialized: Uint8Array): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (JITO_AUTH_UUID) headers["x-jito-auth"] = JITO_AUTH_UUID;

  const response = await fetch(JITO_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [Buffer.from(serialized).toString("base64"), { encoding: "base64" }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as {
    result?: string;
    error?: { code?: number; message?: string; data?: unknown };
  };
  if (!response.ok || body.error || !body.result) {
    throw new Error(
      `Jito send failed: ${response.status} ${JSON.stringify(body.error ?? body)}`
    );
  }

  const signature = body.result;
  const confirmation = await connection.confirmTransaction(
    signature,
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(
      `Jito transaction ${signature} failed: ${JSON.stringify(
        confirmation.value.err
      )}`
    );
  }
  return signature;
}

export async function executeUsdcToTokenSwap(
  targetMint: string
): Promise<SwapExecutionResult> {
  try {
    const quote = await getQuote(targetMint);
    const { transaction, serialized, lastValidBlockHeight } =
      await buildSignedTransaction(quote);

    const signature =
      BROADCAST_MODE === "jito"
        ? await broadcastViaJito(serialized)
        : await broadcastViaHelius(
            serialized,
            transaction,
            lastValidBlockHeight
          );

    return {
      signature,
      broadcastMode: BROADCAST_MODE,
      targetMint,
      inputAmountUi: INPUT_USDC_UI,
      expectedOutputRaw: quote.outAmount,
      minimumOutputRaw: quote.otherAmountThreshold,
      priceImpactPct: Number(quote.priceImpactPct ?? "0"),
      routeLabels: quote.routePlan
        .map((step) => step.swapInfo.label)
        .filter((label): label is string => Boolean(label)),
      lastValidBlockHeight,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /blockhash not found|expired|TransactionExpired|timed out/i.test(message)
    ) {
      throw new Error(`Solana transaction expired before landing: ${message}`);
    }
    if (/429|rate.?limit/i.test(message)) {
      throw new Error(`Upstream rate limit: ${message}`);
    }
    if (/insufficient funds/i.test(message)) {
      throw new Error(`Trading wallet has insufficient USDC/SOL: ${message}`);
    }
    throw new Error(`Swap execution failed: ${message}`);
  }
}
