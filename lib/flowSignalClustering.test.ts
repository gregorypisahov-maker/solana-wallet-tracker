import assert from "node:assert/strict";
import test from "node:test";
import { computeFundingClusterMetrics, type HolderSample } from "../helius-intelligence/flowSignal";

function sample(owner: string, funding_source: string | null): HolderSample {
  return {
    token_account: `token-${owner}`,
    owner,
    amount: 1,
    funding_source,
    recent_sol_delta: null,
  };
}

test("direct holder-funded-holder links form one cluster", () => {
  const metrics = computeFundingClusterMetrics([
    sample("holder-a", "external-a"),
    sample("holder-b", "holder-a"),
    sample("holder-c", "external-c"),
  ]);

  assert.equal(metrics.direct_holder_funding_links, 1);
  assert.equal(metrics.largest_holder_cluster_size, 2);
  assert.equal(metrics.largest_holder_cluster_ratio, 2 / 3);
  assert.equal(metrics.resolved_independent_count, 1);
  assert.equal(metrics.resolved_independent_ratio, 1 / 3);
});

test("unresolved funding never counts as independent evidence", () => {
  const metrics = computeFundingClusterMetrics([
    sample("holder-a", "external-a"),
    sample("holder-b", null),
    sample("holder-c", null),
    sample("holder-d", null),
  ]);

  assert.equal(metrics.resolved_funding_count, 1);
  assert.equal(metrics.unresolved_funding_count, 3);
  assert.equal(metrics.funding_resolution_ratio, 0.25);
  assert.equal(metrics.resolved_independent_count, 1);
  assert.equal(metrics.resolved_independent_ratio, 1);
});

test("holders sharing an external funder form a cluster", () => {
  const metrics = computeFundingClusterMetrics([
    sample("holder-a", "external-x"),
    sample("holder-b", "external-x"),
    sample("holder-c", "external-y"),
  ]);

  assert.equal(metrics.shared_external_funder_links, 1);
  assert.equal(metrics.largest_holder_cluster_size, 2);
  assert.equal(metrics.resolved_independent_count, 1);
});
