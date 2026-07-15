import assert from "node:assert/strict";
import test from "node:test";
import {
  SerialEventQueue,
  SignatureDeduper,
  signatureEventKey,
} from "./eventIntake";

test("SignatureDeduper expires old entries and caps memory", () => {
  const deduper = new SignatureDeduper(1_000, 2);

  deduper.mark("one", 1_000);
  deduper.mark("two", 1_100);
  assert.equal(deduper.has("one", 1_500), true);

  deduper.mark("three", 1_200);
  assert.equal(deduper.has("one", 1_200), false);
  assert.equal(deduper.has("two", 1_200), true);
  assert.equal(deduper.has("two", 2_101), false);
});

test("SerialEventQueue runs once per queued key and preserves order", async () => {
  const handled: number[] = [];
  const errors: unknown[] = [];
  const queue = new SerialEventQueue<number>(
    async (value) => {
      handled.push(value);
    },
    (error) => errors.push(error)
  );

  assert.equal(queue.enqueue("same", 1), true);
  assert.equal(queue.enqueue("same", 2), false);
  assert.equal(queue.enqueue("other", 3), true);
  await queue.whenIdle();

  assert.deepEqual(handled, [1, 3]);
  assert.deepEqual(errors, []);
});

test("signatureEventKey keeps the wallet in the dedupe identity", () => {
  assert.notEqual(
    signatureEventKey("wallet-a", "signature"),
    signatureEventKey("wallet-b", "signature")
  );
});
