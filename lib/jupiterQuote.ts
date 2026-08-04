import { PublicKey } from "@solana/web3.js";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || "";
const JUPITER_BASE = (
  process.env.JUPITER_API_BASE_URL?.trim() ||
  (JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1")
).replace(/\/$/, "");
const JUPITER_QUOTE_URL = `${JUPITER_BASE}/quote`;
const HTTP_TIMEOUT_MS = Math.max(3_000, Number(process.env.JUPITER_HTTP_TIMEOUT_MS) || 12_000);
const HTTP_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.JUPITER_HTTP_ATTEMPTS) || 3));
const MIN_REQUEST_INTERVAL_MS = Math.max(
  JUPITER_API_KEY ? 1_100 : 2_100,
  Number(process.env.JUPITER_MIN_REQUEST_INTERVAL_MS) || 0,
);

let nextAllowedRequestAt = 0;
let requestChain: Promise<void> = Promise.resolve();

export const JUPITER_SOL_MINT = "So11111111111111111111111111111111111111112";

export type JupiterQuoteOnlyResult = {
  outLamports: bigint;
  route: boolean;
  raw: Record<string, unknown> | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function headers(): Record<string, string> {
  return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
}

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

async function acquireRequestSlot(): Promise<void> {
  const previous = requestChain;
  let release!: () => void;
  requestChain = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const delay = nextAllowedRequestAt - Date.now();
    if (delay > 0) await sleep(delay);
    nextAllowedRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

export function getJupiterClientStatus() {
  return {
    baseUrl: JUPITER_BASE,
    apiKeyConfigured: Boolean(JUPITER_API_KEY),
    minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  };
}

export async function getJupiterQuote(input: {
  inputMint: string;
  outputMint: string;
  rawTokenAmount: string;
  slippageBps: number;
}): Promise<JupiterQuoteOnlyResult> {
  if (!/^\d+$/.test(input.rawTokenAmount) || BigInt(input.rawTokenAmount) <= 0n) {
    throw new Error("invalid_quote_amount");
  }
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 10 || input.slippageBps > 200) {
    throw new Error("quote_slippage_out_of_bounds");
  }
  new PublicKey(input.inputMint);
  new PublicKey(input.outputMint);

  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", input.inputMint);
  url.searchParams.set("outputMint", input.outputMint);
  url.searchParams.set("amount", input.rawTokenAmount);
  url.searchParams.set("slippageBps", String(input.slippageBps));
  url.searchParams.set("restrictIntermediateTokens", "true");

  let lastError = "jupiter_quote_failed";
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt += 1) {
    await acquireRequestSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: headers(),
      });
      if (response.ok) {
        const raw = (await response.json()) as Record<string, unknown>;
        const outAmount = typeof raw.outAmount === "string" ? raw.outAmount : "0";
        const outLamports = /^\d+$/.test(outAmount) ? BigInt(outAmount) : 0n;
        return { outLamports, route: outLamports > 0n, raw };
      }

      const body = await response.text().catch(() => "");
      const retryAfter = response.headers.get("retry-after");
      lastError = `jupiter_quote_http_${response.status}${retryAfter ? `_retry_after_${retryAfter}` : ""}:${body.slice(0, 300)}`;
      if (response.status === 400 || response.status === 404) {
        return { outLamports: 0n, route: false, raw: null };
      }
      if (response.status === 429) throw new Error(lastError);
      if (!retryable(response.status)) throw new Error(lastError);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (/jupiter_quote_http_429/i.test(lastError)) throw new Error(lastError);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < HTTP_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }

  throw new Error(lastError);
}
