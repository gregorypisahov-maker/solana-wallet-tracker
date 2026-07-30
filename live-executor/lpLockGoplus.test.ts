import assert from "node:assert/strict";
import test from "node:test";
import { classifyLpLock } from "./lpLockGoplus";

const MINT = "Mint111111111111111111111111111111111111111";
const POOL = "Pool111111111111111111111111111111111111111";

function response(holders: any[], extra: Record<string, unknown> = {}) {
  return {
    code: 1,
    result: {
      [MINT]: {
        dex: [{ id: POOL, tvl: "100000", lp_holders: holders, ...extra }],
      },
    },
  };
}

test("classifies mostly burned LP as locked", () => {
  const result = classifyLpLock(response([
    { token_account: "1nc1nerator11111111111111111111111111111111", percent: "0.96" },
  ]), MINT, { poolAddress: POOL });
  assert.equal(result.verdict, "LOCKED");
  assert.equal(result.method, "goplus_lp_holders");
  assert.equal(result.pctBurned, 96);
});

test("classifies locker-held LP with numeric is_locked", () => {
  const result = classifyLpLock(response([
    { token_account: "locker", is_locked: 1, percent: 0.95, locked_detail: [{ unlock_time: 2_000_000_000 }] },
  ]), MINT);
  assert.equal(result.verdict, "LOCKED");
  assert.equal(result.pctLocked, 95);
  assert.ok(result.unlockTime);
});

test("accepts string is_locked", () => {
  const result = classifyLpLock(response([
    { token_account: "locker", is_locked: "1", percent: "0.95" },
  ]), MINT);
  assert.equal(result.verdict, "LOCKED");
});

test("normalizes 0-100 percent scale", () => {
  const result = classifyLpLock(response([
    { token_account: "locker", is_locked: "1", percent: "95" },
  ]), MINT);
  assert.equal(result.verdict, "LOCKED");
  assert.equal(result.pctLocked, 95);
});

test("does not mistake a concentrated unlocked holder for a lock", () => {
  const result = classifyLpLock(response([
    { token_account: "developer", is_locked: 0, percent: 0.99 },
  ]), MINT);
  assert.equal(result.verdict, "UNLOCKED");
  assert.equal(result.pctLocked, 0);
});

test("distinguishes fresh token not indexed", () => {
  const result = classifyLpLock({ code: 2007, message: "Not contract address!" }, MINT);
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.method, "goplus_token_not_indexed");
});

test("distinguishes empty dex coverage", () => {
  const result = classifyLpLock({ code: 1, result: { [MINT]: { dex: [] } } }, MINT);
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.method, "goplus_no_dex");
});

test("distinguishes dex without LP holders", () => {
  const result = classifyLpLock({ code: 1, result: { [MINT]: { dex: [{ id: POOL }] } } }, MINT);
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.method, "goplus_no_lp_holders");
  assert.equal(result.pool, POOL);
});
