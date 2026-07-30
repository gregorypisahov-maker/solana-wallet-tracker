import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  calculateReservePrice,
  decodePumpBondingCurveAccount,
  decodePumpSwapPoolAccount,
} from "./heliusPrice";

const PUMPSWAP_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const PUMP_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);

function key(): PublicKey {
  return Keypair.generate().publicKey;
}

function writeKey(buffer: Buffer, offset: number, value: PublicKey): void {
  value.toBuffer().copy(buffer, offset);
}

function writeI128LE(buffer: Buffer, offset: number, value: bigint): void {
  const normalized = value < 0n ? (1n << 128n) + value : value;
  buffer.writeBigUInt64LE(normalized & ((1n << 64n) - 1n), offset);
  buffer.writeBigUInt64LE(normalized >> 64n, offset + 8);
}

test("decodes the current PumpSwap Pool layout including virtual quote reserves", () => {
  const data = Buffer.alloc(261);
  PUMPSWAP_POOL_DISCRIMINATOR.copy(data, 0);
  const baseMint = key();
  const quoteMint = key();
  const baseVault = key();
  const quoteVault = key();
  writeKey(data, 43, baseMint);
  writeKey(data, 75, quoteMint);
  writeKey(data, 139, baseVault);
  writeKey(data, 171, quoteVault);
  writeI128LE(data, 245, 1_250_000n);

  assert.deepEqual(decodePumpSwapPoolAccount(data), {
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    baseVault: baseVault.toBase58(),
    quoteVault: quoteVault.toBase58(),
    virtualQuoteReserves: 1_250_000n,
  });
});

test("legacy PumpSwap pools without the appended virtual reserve decode as zero", () => {
  const data = Buffer.alloc(245);
  PUMPSWAP_POOL_DISCRIMINATOR.copy(data, 0);
  const baseMint = key();
  const quoteMint = key();
  const baseVault = key();
  const quoteVault = key();
  writeKey(data, 43, baseMint);
  writeKey(data, 75, quoteMint);
  writeKey(data, 139, baseVault);
  writeKey(data, 171, quoteVault);

  const decoded = decodePumpSwapPoolAccount(data);
  assert.equal(decoded?.virtualQuoteReserves, 0n);
});

test("decodes Pump bonding curve virtual reserves and quote mint", () => {
  const data = Buffer.alloc(115);
  PUMP_CURVE_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(1_000_000_000_000n, 8);
  data.writeBigUInt64LE(50_000_000_000n, 16);
  data.writeBigUInt64LE(900_000_000_000n, 24);
  data.writeBigUInt64LE(40_000_000_000n, 32);
  data.writeBigUInt64LE(1_000_000_000_000n, 40);
  data[48] = 0;
  const quoteMint = key();
  writeKey(data, 83, quoteMint);

  assert.deepEqual(decodePumpBondingCurveAccount(data), {
    virtualTokenReserves: 1_000_000_000_000n,
    virtualQuoteReserves: 50_000_000_000n,
    complete: false,
    quoteMint: quoteMint.toBase58(),
  });
});

test("calculates reserve price with token decimals and virtual quote liquidity", () => {
  const result = calculateReservePrice({
    baseAmount: 1_000_000_000n,
    baseDecimals: 6,
    quoteAmount: 10_000_000_000n,
    quoteDecimals: 9,
    virtualQuoteAmount: 5_000_000_000n,
    quoteUsd: 150,
  });
  assert.ok(result);
  assert.equal(result?.priceNative, 0.015);
  assert.equal(result?.priceUsd, 2.25);
});

test("unknown discriminators return null instead of guessing", () => {
  assert.equal(decodePumpSwapPoolAccount(Buffer.alloc(261)), null);
  assert.equal(decodePumpBondingCurveAccount(Buffer.alloc(115)), null);
});
