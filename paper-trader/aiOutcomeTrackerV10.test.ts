import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

test("outcome horizons are only due inside their own measurement window", async () => {
  const { horizonState } = await import("./aiOutcomeTrackerV10");
  const observedAt = "2026-07-30T00:00:00.000Z";
  const at = (minutes: number, seconds = 0) =>
    Date.parse(observedAt) + minutes * 60_000 + seconds * 1_000;

  assert.equal(horizonState(observedAt, 5, at(3)), "pending");
  assert.equal(horizonState(observedAt, 5, at(5)), "due");
  assert.equal(horizonState(observedAt, 5, at(6, 31)), "missed");

  assert.equal(horizonState(observedAt, 15, at(12, 59)), "pending");
  assert.equal(horizonState(observedAt, 15, at(15)), "due");
  assert.equal(horizonState(observedAt, 15, at(17, 1)), "missed");

  assert.equal(horizonState(observedAt, 30, at(30)), "due");
  assert.equal(horizonState(observedAt, 45, at(45)), "due");
});
