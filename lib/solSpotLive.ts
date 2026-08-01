import { PublicKey } from "@solana/web3.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const SOL_DECIMALS = 9;
export const USDT_DECIMALS = 6;
export const JUPITER_SWAP_V2_BASE_URL = "https://api.jup.ag/swap/v2";
export const JUPITER_LITE_V1_BASE_URL = "https://lite-api.jup.ag/swap/v1";
export const LIVE_ARM_HOURS = 6;
export const LIVE_ORDER_TTL_SECONDS = 90;

export function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isValidSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return new PublicKey(value.trim()).toBase58() === value.trim();
  } catch {
    return false;
  }
}

export function hasJupiterApiKey(): boolean {
  return Boolean(process.env.JUPITER_API_KEY?.trim());
}

export function jupiterHeaders(json = false): Record<string, string> {
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
}

export function getLiveRpcUrl(): string {
  return (
    process.env.HELIUS_RPC_URL?.trim() ||
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.ALCHEMY_RPC_URL?.trim() ||
    "https://api.mainnet-beta.solana.com"
  );
}

export function toAtomic(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("invalid_amount");
  return Math.floor(amount * 10 ** decimals).toString();
}

export function fromAtomic(amount: unknown, decimals: number): number {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed / 10 ** decimals : 0;
}
