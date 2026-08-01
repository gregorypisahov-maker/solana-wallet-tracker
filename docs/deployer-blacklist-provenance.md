# Deployer blacklist provenance

| Claim | Status | Evidence |
|---|---|---|
| `live-executor/liveSafety.ts` exports `evaluateLiveEntrySafety` and ends with a single final `passed: true` return | verified-from-repo/DB | Current `main` at `4ca0af44`; patch anchors verified before writing. |
| Paper AI calls the shared safety function only after its `MIN_SCORE = 82` opportunity gate | verified-from-repo/DB | `paper-trader/aiDiscoveryTrader.ts`; current strategy constant and import verified. |
| `ai_discovery_trades` contains 184 rows and has `mint`, `opened_at`, `closed_at`, `exit_reason`, `net_return_pct`, and `pnl_sol` | verified-from-repo/DB | Supabase production schema inspected 2026-08-01. |
| Rug definition is the requested three exit reasons or `net_return_pct <= -80` | inferred | Product policy supplied in implementation spec; now encoded identically in migration, backfill, and replay. |
| Helius `getAsset` creator/authority shapes can vary by asset/program | inferred | Resolver checks multiple documented/common fields and fails open. |
| Oldest mint signature fee-payer is the deployer when `getAsset` has no creator | inferred | Required fallback heuristic; cached with method `mint_creation_signer`. |
| Enforcement should remain disabled | verified-from-repo/DB | No historical deployers are resolved yet in production, so acceptance replay cannot produce a meaningful catch-rate result. |

## Rollout

1. Deploy with `LIVE_DEPLOYER_BLACKLIST_ENFORCE=false`.
2. Run `npm run deployer:backfill` once in the Railway environment with Helius/Supabase credentials.
3. Run `npm run deployer:replay` and attach its JSON output to the PR.
4. Enable enforcement only after the no-lookahead replay shows a meaningful catch rate and acceptable winner cost.

## Fail-loud patch

`apply-deployer-blacklist-fix.mjs` throws and exits non-zero when either the import anchor or the final `passed:true` anchor is missing. It verifies the written marker and reject branch before reporting success. A second run exits successfully via the marker check without rewriting.

## Known limitation

This catches repeat ruggers only. A new deployer's first rug still passes. LP lock/burn and authority resolution remain a separate companion build and are intentionally out of scope.
