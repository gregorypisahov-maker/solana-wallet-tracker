import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEntryConfirmation,
  MAX_ENTRY_CONFIRMATION_DROP_PCT,
  MAX_ENTRY_CONFIRMATION_RISE_PCT,
} from "./entryConfirmation";

test("accepts a stable price during confirmation", () => {
  const result = evaluateEntryConfirmation(100, 102);

  assert.equal(result.pass, true);
  assert.equal(result.reason, null);
  assert.equal(result.priceChangePct, 0.02);
});

test("accepts movement exactly at the confirmation boundaries", () => {
  assert.equal(
    evaluateEntryConfirmation(
      100,
      100 * (1 - MAX_ENTRY_CONFIRMATION_DROP_PCT)
    ).pass,
    true
  );
  assert.equal(
    evaluateEntryConfirmation(
      100,
      100 * (1 + MAX_ENTRY_CONFIRMATION_RISE_PCT)
    ).pass,
    true
  );
});

test("rejects a collapsing price before entry", () => {
  const result = evaluateEntryConfirmation(100, 94);

  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /price fell 6\.0%/);
});

test("rejects an entry that would chase an active spike", () => {
  const result = evaluateEntryConfirmation(100, 108);

  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /chasing an active spike/);
});

test("fails closed on invalid prices", () => {
  assert.throws(() => evaluateEntryConfirmation(0, 1), /Invalid initial/);
  assert.throws(() => evaluateEntryConfirmation(1, Number.NaN), /Invalid confirmed/);
});
