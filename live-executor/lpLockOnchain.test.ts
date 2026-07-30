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
const DEV = key(12).toBase58();

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
  const lpMint = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), POOL.toBuffer()],
    PUMP_AMM_PROGRAM
  )[0];
  const poolData = Buffer.alloc(240);
  lpMint.toBuffer().copy(poolData, 107);
  BASE_VAULT.toBuffer().copy(poolData, 139);
  QUOTE_VAULT.toBuffer().copy(poolData, 171);
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "100000" }),
    getAccountInfo: async () => account(PUMP_AMM_PROGRAM, poolData),
    getTokenSupply: async () => ({ context: { slot: 1 }, value: { amount: "1000", decimals: 6, uiAmount: 0.001, uiAmountString: "0.001" } }),
    getTokenLargestAccounts: async () => ({ context: { slot: 1 }, value: [{ address: LP_ACCOUNT, amount: "960", decimals: 6, uiAmount: 0.00096, uiAmountString: "0.00096" }] }),
    getMultipleParsedAccounts: async () => ({ context: { slot: 1 }, value: [{ data: { parsed: { info: { owner: INCINERATOR } } } }] }),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58(), lockMinPct: 95 });
  assert.equal(result.verdict, "LOCKED");
  assert.equal(result.method, "onchain_lp_burn");
  assert.equal(result.pctBurned, 96);
});

test("PumpSwap LP held by an ordinary wallet is unlocked", async () => {
  const lpMint = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), POOL.toBuffer()],
    PUMP_AMM_PROGRAM
  )[0];
  const poolData = Buffer.alloc(240);
  lpMint.toBuffer().copy(poolData, 107);
  BASE_VAULT.toBuffer().copy(poolData, 139);
  QUOTE_VAULT.toBuffer().copy(poolData, 171);
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "100000" }),
    getAccountInfo: async () => account(PUMP_AMM_PROGRAM, poolData),
    getTokenSupply: async () => ({ context: { slot: 1 }, value: { amount: "1000", decimals: 6, uiAmount: 0.001, uiAmountString: "0.001" } }),
    getTokenLargestAccounts: async () => ({ context: { slot: 1 }, value: [{ address: LP_ACCOUNT, amount: "1000", decimals: 6, uiAmount: 0.001, uiAmountString: "0.001" }] }),
    getMultipleParsedAccounts: async () => ({ context: { slot: 1 }, value: [{ data: { parsed: { info: { owner: DEV } } } }] }),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58(), lockMinPct: 95 });
  assert.equal(result.verdict, "UNLOCKED");
  assert.equal(result.reason, "insufficient_liquidity_locked");
});

test("unresolved LP with excessive non-pool holder concentration is unsafe", async () => {
  const unsupportedProgram = key(20);
  const topAccount = key(21);
  const connection = connectionMock({
    getParsedAccountInfo: async () => mintResponse({ mintAuthority: null, freezeAuthority: null, supply: "1000" }),
    getAccountInfo: async () => account(unsupportedProgram, Buffer.alloc(64)),
    getTokenLargestAccounts: async () => ({ context: { slot: 1 }, value: [{ address: topAccount, amount: "350", decimals: 6, uiAmount: 0.00035, uiAmountString: "0.00035" }] }),
    getMultipleParsedAccounts: async () => ({ context: { slot: 1 }, value: [{ data: { parsed: { info: { owner: DEV } } } }] }),
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
    getMultipleParsedAccounts: async () => ({ context: { slot: 1 }, value: [{ data: { parsed: { info: { owner: DEV } } } }] }),
  });
  const result = await evaluateOnchainLiquiditySafety({ connection, mint: MINT.toBase58(), poolAddress: POOL.toBase58(), maxTopHolderPct: 30 });
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.reason, "lp_mint_unresolved");
});
