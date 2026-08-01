import { PublicKey } from "@solana/web3.js";
import { FetchPriority, fetchJsonQueued } from "../paper-trader/fetchQueue";

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const PUMPSWAP_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const DEX_PRICE_URL = "https://api.dexscreener.com/tokens/v1/solana";

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

function envNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export const HELIUS_PRICE_ENABLED = envFlag("HELIUS_PRICE_ENABLED", true);
export const HELIUS_PRICE_TTL_MS = envNumber("HELIUS_PRICE_TTL_MS", 5_000, 500, 60_000);
const HELIUS_PRICE_TIMEOUT_MS = envNumber("HELIUS_PRICE_TIMEOUT_MS", 8_000, 2_000, 20_000);
const DEX_PRICE_FALLBACK_ENABLED = envFlag("HELIUS_PRICE_DEX_FALLBACK_ENABLED", true);
const DEX_PRICE_FALLBACK_TTL_MS = envNumber("HELIUS_PRICE_DEX_FALLBACK_TTL_MS", 10_000, 1_000, 60_000);
const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim() ?? "";
const HELIUS_RPC_URL =
  process.env.HELIUS_RPC_URL?.trim() ||
  (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "");

export type HeliusPriceSource = "helius" | "cache" | "dex-fallback";

export type HeliusPrice = {
  priceUsd: number;
  priceNative: number;
  source: HeliusPriceSource;
  poolProgram: "pumpswap" | "pump-bonding-curve" | "helius-das" | "dex-fallback";
  poolAddress: string | null;
  quoteMint: string | null;
  observedAt: string;
};

export type DecodedPumpSwapPool = {
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  virtualQuoteReserves: bigint;
};

export type DecodedPumpBondingCurve = {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  complete: boolean;
  quoteMint: string;
};

type RpcAccount = { owner: string; data: Buffer };
type TokenBalance = { amount: bigint; decimals: number };

type CachedPrice = { expiresAt: number; value: HeliusPrice };
const priceCache = new Map<string, CachedPrice>();
const inFlight = new Map<string, Promise<HeliusPrice | null>>();
const quoteUsdCache = new Map<string, { expiresAt: number; value: number }>();
let requestId = 0;

function positive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cacheKey(mint: string, poolAddress?: string | null): string {
  return `${mint}:${poolAddress ?? "no-pool"}`;
}

function publicKeyAt(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readI128LE(data: Buffer, offset: number): bigint {
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigUInt64LE(offset + 8);
  let value = low | (high << 64n);
  if ((value & (1n << 127n)) !== 0n) value -= 1n << 128n;
  return value;
}

function decimalAmount(amount: bigint, decimals: number): number {
  if (decimals < 0 || decimals > 18) return Number.NaN;
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  return Number(whole) + Number(fraction) / 10 ** decimals;
}

function isZeroKey(value: string): boolean {
  return value === "11111111111111111111111111111111";
}

export function decodePumpSwapPoolAccount(data: Buffer): DecodedPumpSwapPool | null {
  // Anchor discriminator + fields from the official PumpSwap Pool IDL.
  // virtual_quote_reserves was appended later, so legacy pools safely default to zero.
  if (data.length < 203 || !data.subarray(0, 8).equals(PUMPSWAP_POOL_DISCRIMINATOR)) return null;
  try {
    return {
      baseMint: publicKeyAt(data, 43),
      quoteMint: publicKeyAt(data, 75),
      baseVault: publicKeyAt(data, 139),
      quoteVault: publicKeyAt(data, 171),
      virtualQuoteReserves: data.length >= 261 ? readI128LE(data, 245) : 0n,
    };
  } catch {
    return null;
  }
}

export function decodePumpBondingCurveAccount(data: Buffer): DecodedPumpBondingCurve | null {
  if (data.length < 49 || !data.subarray(0, 8).equals(PUMP_CURVE_DISCRIMINATOR)) return null;
  try {
    const quoteMint = data.length >= 115 ? publicKeyAt(data, 83) : WRAPPED_SOL;
    return {
      virtualTokenReserves: data.readBigUInt64LE(8),
      virtualQuoteReserves: data.readBigUInt64LE(16),
      complete: data[48] === 1,
      quoteMint: isZeroKey(quoteMint) ? WRAPPED_SOL : quoteMint,
    };
  } catch {
    return null;
  }
}

export function calculateReservePrice(input: {
  baseAmount: bigint;
  baseDecimals: number;
  quoteAmount: bigint;
  quoteDecimals: number;
  virtualQuoteAmount?: bigint;
  quoteUsd: number;
}): { priceNative: number; priceUsd: number } | null {
  const base = decimalAmount(input.baseAmount, input.baseDecimals);
  const quoteRaw = input.quoteAmount + (input.virtualQuoteAmount ?? 0n);
  const quote = decimalAmount(quoteRaw, input.quoteDecimals);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(quote) || quote <= 0) return null;
  if (!Number.isFinite(input.quoteUsd) || input.quoteUsd <= 0) return null;
  const priceNative = quote / base;
  const priceUsd = priceNative * input.quoteUsd;
  return Number.isFinite(priceUsd) && priceUsd > 0 ? { priceNative, priceUsd } : null;
}

async function heliusRpc<T>(method: string, params: unknown): Promise<T | null> {
  if (!HELIUS_PRICE_ENABLED || !HELIUS_RPC_URL) return null;
  try {
    const body = await fetchJsonQueued(HELIUS_RPC_URL, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: `price-${Date.now()}-${requestId++}`, method, params }),
      headers: { "content-type": "application/json" },
      timeoutMs: HELIUS_PRICE_TIMEOUT_MS,
      priority: FetchPriority.HIGH,
      cacheTtlMs: 0,
    });
    if (body?.error) return null;
    return (body?.result ?? null) as T | null;
  } catch {
    return null;
  }
}

function decodeRpcData(value: any): Buffer | null {
  const raw = value?.data;
  const encoded = Array.isArray(raw) ? raw[0] : raw;
  if (typeof encoded !== "string" || !encoded) return null;
  try {
    return Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
}

async function accountInfo(address: string): Promise<RpcAccount | null> {
  const result = await heliusRpc<any>("getAccountInfo", [
    address,
    { encoding: "base64", commitment: "processed" },
  ]);
  const value = result?.value;
  const data = decodeRpcData(value);
  return value?.owner && data ? { owner: String(value.owner), data } : null;
}

async function tokenBalance(address: string): Promise<TokenBalance | null> {
  const result = await heliusRpc<any>("getTokenAccountBalance", [address, { commitment: "processed" }]);
  const amount = result?.value?.amount;
  const decimals = Number(result?.value?.decimals);
  if (typeof amount !== "string" || !/^\d+$/.test(amount) || !Number.isInteger(decimals)) return null;
  return { amount: BigInt(amount), decimals };
}

async function mintDecimals(mint: string): Promise<number | null> {
  const result = await heliusRpc<any>("getTokenSupply", [mint, { commitment: "processed" }]);
  const decimals = Number(result?.value?.decimals);
  return Number.isInteger(decimals) && decimals >= 0 ? decimals : null;
}

async function indexedUsdPrice(mint: string): Promise<number | null> {
  if (mint === USDC || mint === USDT) return 1;
  const cached = quoteUsdCache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const result = await heliusRpc<any>("getAsset", { id: mint });
  const info = result?.token_info?.price_info;
  const currency = String(info?.currency ?? "").toUpperCase();
  const price = positive(info?.price_per_token);
  if (!price || !["USD", "USDC", "USDT"].includes(currency)) return null;
  quoteUsdCache.set(mint, { expiresAt: Date.now() + 60_000, value: price });
  return price;
}

async function priceFromDexFallback(
  mint: string,
  poolAddress?: string | null
): Promise<HeliusPrice | null> {
  if (!DEX_PRICE_FALLBACK_ENABLED) return null;
  try {
    const body = await fetchJsonQueued(`${DEX_PRICE_URL}/${encodeURIComponent(mint)}`, {
      timeoutMs: HELIUS_PRICE_TIMEOUT_MS,
      priority: FetchPriority.HIGH,
      cacheTtlMs: DEX_PRICE_FALLBACK_TTL_MS,
    });
    const pairs = (Array.isArray(body) ? body : []).filter(
      (item: any) => item?.chainId === "solana" && item?.baseToken?.address === mint
    );
    const exact = poolAddress
      ? pairs.find((item: any) => String(item?.pairAddress ?? "") === poolAddress)
      : null;
    const pair = exact ?? pairs.sort(
      (a: any, b: any) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0)
    )[0];
    const priceUsd = positive(pair?.priceUsd);
    if (!pair || !priceUsd) return null;
    return {
      priceUsd,
      priceNative: priceUsd,
      source: "dex-fallback",
      poolProgram: "dex-fallback",
      poolAddress: String(pair?.pairAddress ?? poolAddress ?? "") || null,
      quoteMint: String(pair?.quoteToken?.address ?? "") || null,
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function priceFromPumpSwap(
  mint: string,
  poolAddress: string,
  account: RpcAccount
): Promise<HeliusPrice | null> {
  const pool = decodePumpSwapPoolAccount(account.data);
  if (!pool || pool.baseMint !== mint) return null;
  const [base, quote, quoteUsd] = await Promise.all([
    tokenBalance(pool.baseVault),
    tokenBalance(pool.quoteVault),
    indexedUsdPrice(pool.quoteMint),
  ]);
  if (!base || !quote || !quoteUsd) return null;
  const calculated = calculateReservePrice({
    baseAmount: base.amount,
    baseDecimals: base.decimals,
    quoteAmount: quote.amount,
    quoteDecimals: quote.decimals,
    virtualQuoteAmount: pool.virtualQuoteReserves,
    quoteUsd,
  });
  if (!calculated) return null;
  return {
    ...calculated,
    source: "helius",
    poolProgram: "pumpswap",
    poolAddress,
    quoteMint: pool.quoteMint,
    observedAt: new Date().toISOString(),
  };
}

async function priceFromPumpCurve(
  mint: string,
  poolAddress: string,
  account: RpcAccount
): Promise<HeliusPrice | null> {
  const curve = decodePumpBondingCurveAccount(account.data);
  if (!curve || curve.complete || curve.virtualTokenReserves <= 0n || curve.virtualQuoteReserves <= 0n) {
    return null;
  }
  const [baseDecimals, quoteUsd] = await Promise.all([
    mintDecimals(mint),
    indexedUsdPrice(curve.quoteMint),
  ]);
  if (baseDecimals == null || !quoteUsd) return null;
  const quoteDecimals = curve.quoteMint === WRAPPED_SOL ? 9 : curve.quoteMint === USDC || curve.quoteMint === USDT ? 6 : null;
  if (quoteDecimals == null) return null;
  const calculated = calculateReservePrice({
    baseAmount: curve.virtualTokenReserves,
    baseDecimals,
    quoteAmount: curve.virtualQuoteReserves,
    quoteDecimals,
    quoteUsd,
  });
  if (!calculated) return null;
  return {
    ...calculated,
    source: "helius",
    poolProgram: "pump-bonding-curve",
    poolAddress,
    quoteMint: curve.quoteMint,
    observedAt: new Date().toISOString(),
  };
}

async function resolveFresh(mint: string, poolAddress?: string | null): Promise<HeliusPrice | null> {
  if (!HELIUS_PRICE_ENABLED || !HELIUS_RPC_URL) {
    return priceFromDexFallback(mint, poolAddress);
  }

  if (poolAddress) {
    const account = await accountInfo(poolAddress);
    if (account?.owner === PUMPSWAP_PROGRAM.toBase58()) {
      return (await priceFromPumpSwap(mint, poolAddress, account)) ?? priceFromDexFallback(mint, poolAddress);
    }
    if (account?.owner === PUMP_PROGRAM.toBase58()) {
      return (await priceFromPumpCurve(mint, poolAddress, account)) ?? priceFromDexFallback(mint, poolAddress);
    }
    // Unsupported pools use the same shared queued/cached DexScreener path as
    // the rest of the worker instead of forcing every caller to issue another
    // independent request. This keeps fresh candidates from silently vanishing.
    return priceFromDexFallback(mint, poolAddress);
  }

  // Indexed DAS prices can be up to ten minutes old, so they are used only when
  // no pool account was supplied. High-frequency callers always provide a pool.
  const priceUsd = await indexedUsdPrice(mint);
  if (!priceUsd) return priceFromDexFallback(mint, null);
  return {
    priceUsd,
    priceNative: priceUsd,
    source: "helius",
    poolProgram: "helius-das",
    poolAddress: null,
    quoteMint: USDC,
    observedAt: new Date().toISOString(),
  };
}

export async function getPriceViaHelius(
  mint: string,
  poolAddress?: string | null
): Promise<HeliusPrice | null> {
  const key = cacheKey(mint, poolAddress);
  const cached = priceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, source: "cache", observedAt: new Date().toISOString() };
  }
  if (cached) priceCache.delete(key);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = resolveFresh(mint, poolAddress)
    .then((value) => {
      if (value) priceCache.set(key, { expiresAt: Date.now() + HELIUS_PRICE_TTL_MS, value });
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

console.log(
  `[helius-price] enabled=${HELIUS_PRICE_ENABLED} ttlMs=${HELIUS_PRICE_TTL_MS} ` +
    `rpc=${HELIUS_RPC_URL ? "configured" : "missing"} decoders=pumpswap,pump-bonding-curve ` +
    `dexFallback=${DEX_PRICE_FALLBACK_ENABLED}`
);
