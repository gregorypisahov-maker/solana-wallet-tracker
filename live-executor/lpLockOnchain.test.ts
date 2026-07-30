import assert from "node:assert/strict";
import test from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { evaluateOnchainLiquiditySafety } from "./lpLockOnchain";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

function key(byte: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
}

const MINT = key(7);
const POOL = key(8);
const LP_ACCOUNT = key(9);
const BASE_VAULT = key(10);
const QUOTE_VAULT = key(11);
const DEV_KEY = key(12);
const SMALL_HOLDER = key(13);
const DEV = DEV_KEY.toBase58();

function mintResponse(info: Record<string, unknown>) {
  return {
    context: { slot: 1 },
    value: {
      data: { parsed: { info }, program: "spl-token", space: 82 },
      executable: false,
      lamports: 1,
      owner: TOKEN_PROGRAM,
      rentEpoch: 0,
    },
  } as any;
}

function account(owner: PublicKey, data: Buffer) {
  return { executable: false, lamports: 1, owner, rentEpoch: 0, data } as any;
}

function connectionMock(overrides: Record<string, unknown>): Connection {
  return overrides as unknown as Connection;
}

function poolData(lpMint: PublicKey): Buffer {
  const data = Buffer.alloc(240);
  lpMint.toBuffer().copy(data, 107);
  BASE_VAULT.toBuffer().copy(data, 139);
  QUOTE_VAULT.toBuffer().copy(data, 171);
  return data;
}

function parsedOwners(addresses: PublicKey[], lpOwner: string) {
  return {
    context: { slot: 1 },
    value: addresses.map((address) => ({
      data: {
        parsed: {
          info: {
            owner: address.equals(LP_ACCOUNT) ? lpOwner : DEV,
          },
        },
      },
    })),
  } as any;
}

function safeTokenLargest() {
  return {
    context: { slot: 1 },
    value: [
      { address: BASE_VAULT, amount: "90000", decimals: 6, uiAmount: 0.09, uiAmountString: "0.09" },
      { address: SMALL_HOLDER, amount: "10000", decimals: 6, uiAmount: 0.01, uiAmountString: "0.01" },
    ],
  };
}

test("active mint authority is unsafe before LP checks", async () => {
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: DEV, freezeAuthority: null, supply: "1000" }),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58() });
  assert.equal(result.verdict, "UNLOCKED");
  assert.equal(result.method, "onchain_authorities");
  assert.equal(result.reason, "mint_authority_active");
});

test("renounced mint on Pump bonding curve is protocol controlled", async () => {
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "1000" }),
    getAccountInfo: async () => account(PUMP_PROGRAM, Buffer.alloc(128)),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58() });
  assert.equal(result.verdict, "LOCKED");
  assert.equal(result.status, "protocol_controlled");
  assert.equal(result.method, "onchain_lp_burn");
});

test("PumpSwap LP held by incinerator is locked", async () => {
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), POOL.toBuffer()], PUMP_AMM_PROGRAM)[0];
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "100000" }),
    getAccountInfo: async () => account(PUMP_AMM_PROGRAM, poolData(lpMint)),
    getTokenSupply: async () => ({ context: { slot: 1 }, value: { amount: "1000", decimals: 6, uiAmount: 0.001, uiAmountString: "0.001" } }),
    getTokenLargestAccounts: async (queriedMint: PublicKey) => queriedMint.equals(MINT)
      ? safeTokenLargest()
      : { context: { slot: 1 }, value: [{ address: LP_ACCOUNT, amount: "960", decimals: 6, uiAmount: 0.00096, uiAmountString: "0.00096" }] },
    getMultipleParsedAccounts: async (addresses: PublicKey[]) => parsedOwners(addresses, INCINERATOR),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58(), lockMinPct: 95 });
  assert.equal(result.verdict, "LOCKED");
  assert.equal(result.method, "onchain_lp_burn");
  assert.equal(result.pctBurned, 96);
});

test("PumpSwap LP held by an ordinary wallet is unlocked", async () => {
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), POOL.toBuffer()], PUMP_AMM_PROGRAM)[0];
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "100000" }),
    getAccountInfo: async () => account(PUMP_AMM_PROGRAM, poolData(lpMint)),
    getTokenSupply: async () => ({ context: { slot: 1 }, value: { amount: "1000", decimals: 6, uiAmount: 0.001, uiAmountString: "0.001" } }),
    getTokenLargestAccounts: async (queriedMint: PublicKey) => queriedMint.equals(MINT)
      ? safeTokenLargest()
      : { context: { slot: 1 }, value: [{ address: LP_ACCOUNT, amount: "1000", decimals: 6, uiAmount: 0.001, uiAmountString: "0.001" }] },
    getMultipleParsedAccounts: async (addresses: PublicKey[]) => parsedOwners(addresses, DEV),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58(), lockMinPct: 95 });
  assert.equal(result.verdict, "UNLOCKED");
  assert.equal(result.reason, "insufficient_liquidity_locked");
});

test("zero LP supply is treated as fully burned when holder concentration is safe", async () => {
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), POOL.toBuffer()], PUMP_AMM_PROGRAM)[0];
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "100000" }),
    getAccountInfo: async () => account(PUMP_AMM_PROGRAM, poolData(lpMint)),
    getTokenSupply: async () => ({ context: { slot: 1 }, value: { amount: "0", decimals: 9, uiAmount: 0, uiAmountString: "0" } }),
    getTokenLargestAccounts: async () => safeTokenLargest(),
    getMultipleParsedAccounts: async (addresses: PublicKey[]) => parsedOwners(addresses, DEV),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58() });
  assert.equal(result.verdict, "LOCKED");
  assert.equal(result.status, "burned");
  assert.equal(result.pctBurned, 100);
});

test("concentrated token supply overrides a burned LP verdict", async () => {
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), POOL.toBuffer()], PUMP_AMM_PROGRAM)[0];
  const topAccount = key(30);
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "1000" }),
    getAccountInfo: async () => account(PUMP_AMM_PROGRAM, poolData(lpMint)),
    getTokenSupply: async () => ({ context: { slot: 1 }, value: { amount: "0", decimals: 9, uiAmount: 0, uiAmountString: "0" } }),
    getTokenLargestAccounts: async () => ({ context: { slot: 1 }, value: [{ address: topAccount, amount: "920", decimals: 6, uiAmount: 0.00092, uiAmountString: "0.00092" }] }),
    getMultipleParsedAccounts: async (addresses: PublicKey[]) => parsedOwners(addresses, DEV),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58(), maxTopHolderPct: 30 });
  assert.equal(result.verdict, "UNLOCKED");
  assert.equal(result.method, "onchain_holder_concentration");
  assert.equal(result.reason, "top_holder_concentration");
});

test("unresolved LP with excessive non-pool holder concentration is unsafe", async () => {
  const unsupportedProgram = key(20);
  const topAccount = key(21);
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "1000" }),
    getAccountInfo: async () => account(unsupportedProgram, Buffer.alloc(64)),
    getTokenLargestAccounts: async () => ({ context: { slot: 1 }, value: [{ address: topAccount, amount: "350", decimals: 6, uiAmount: 0.00035, uiAmountString: "0.00035" }] }),
    getMultipleParsedAccounts: async (addresses: PublicKey[]) => parsedOwners(addresses, DEV),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58(), maxTopHolderPct: 30 });
  assert.equal(result.verdict, "UNLOCKED");
  assert.equal(result.method, "onchain_holder_concentration");
  assert.equal(result.reason, "top_holder_concentration");
});

test("renounced authorities without resolvable LP evidence remains unknown", async () => {
  const unsupportedProgram = key(22);
  const topAccount = key(23);
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "1000" }),
    getAccountInfo: async () => account(unsupportedProgram, Buffer.alloc(64)),
    getTokenLargestAccounts: async () => ({ context: { slot: 1 }, value: [{ address: topAccount, amount: "200", decimals: 6, uiAmount: 0.0002, uiAmountString: "0.0002" }] }),
    getMultipleParsedAccounts: async (addresses: PublicKey[]) => parsedOwners(addresses, DEV),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58(), maxTopHolderPct: 30 });
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.reason, "lp_mint_unresolved");
});
