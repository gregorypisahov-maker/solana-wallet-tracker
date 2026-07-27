import { PublicKey } from "@solana/web3.js";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || "";
const JUPITER_BASE = (
  process.env.JUPITER_API_BASE_URL?.trim() ||
  (JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1")
).replace(/\/$/, "");
const JUPITER_QUOTE_URL = `${JUPITER_BASE}/quote`;
const HTTP_TIMEOUT_MS = Math.max(3_000, Number(process.env.JUPITER_HTTP_TIMEOUT_MS) || 12_000);
const HTTP_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.JUPITER_HTTP_ATTEMPTS) || 3));

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
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
      lastError = `jupiter_quote_http_${response.status}:${body.slice(0, 300)}`;
      if (response.status === 400 || response.status === 404) {
        return { outLamports: 0n, route: false, raw: null };
      }
      if (!retryable(response.status)) throw new Error(lastError);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < HTTP_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }

  throw new Error(lastError);
}
