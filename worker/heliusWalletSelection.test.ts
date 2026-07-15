import assert from "node:assert/strict";
import test from "node:test";
import { selectHeliusWallets } from "./heliusWalletSelection";

test("selectHeliusWallets keeps trusted core and rotates exploration slots", () => {
  const addresses = Array.from({ length: 12 }, (_, index) => `wallet-${index}`);
  const trustScores = new Map(
    addresses.map((address, index) => [address, 100 - index])
  );

  const first = selectHeliusWallets({
    addresses,
    trustScores,
    limit: 6,
    coreCount: 3,
    rotationHours: 6,
    nowMs: 0,
  });
  const second = selectHeliusWallets({
    addresses,
    trustScores,
    limit: 6,
    coreCount: 3,
    rotationHours: 6,
    nowMs: 6 * 3_600_000,
  });

  assert.deepEqual(first.core, ["wallet-0", "wallet-1", "wallet-2"]);
  assert.deepEqual(second.core, first.core);
  assert.equal(first.selected.length, 6);
  assert.equal(second.selected.length, 6);
  assert.notDeepEqual(first.rotating, second.rotating);
});

test("selectHeliusWallets returns every wallet when below the cap", () => {
  const selected = selectHeliusWallets({
    addresses: ["b", "a"],
    trustScores: new Map(),
    limit: 10,
    coreCount: 6,
    rotationHours: 6,
    nowMs: 0,
  });

  assert.deepEqual(selected.selected, ["a", "b"]);
  assert.equal(selected.rotationSlots, 1);
});
