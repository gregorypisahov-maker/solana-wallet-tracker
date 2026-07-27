# Moonshot Bot — Phase 1 Scanner

## Scope

Phase 1 is observation-only. It does not modify Legion, AI Discovery, AI Capital, the live executor, or any existing paper trade.

The dedicated process:

- subscribes to selected Solana program logs through the existing provider-neutral `@solana/web3.js` connection;
- fetches each confirmed transaction with bounded retries;
- extracts non-stable token mints touched by the transaction;
- records candidate and latency evidence in `moonshot_candidates`;
- writes health counters to `moonshot_scanner_state`;
- cannot open a paper or live position.

The database enforces `would_enter = false` during Phase 1.

## Safety defaults

- `ENABLE_MOONSHOT_SCANNER` defaults to `false`.
- No launch-program address is hardcoded.
- Missing or invalid configuration produces a safe idle process, not a crash loop.
- Queue depth is capped.
- Duplicate signatures are suppressed.
- RPC failures are retried and then skipped.
- The process uses a separate Railway start command and imports no trade execution module.

## Railway start command

```text
npm run moonshot-scanner
```

Do not create or enable the Railway service until the feature branch has passed review and the migration has been applied.

## Required environment variables

```text
ENABLE_MOONSHOT_SCANNER=false
MOONSHOT_PROGRAM_IDS=<comma-separated Solana program IDs>
SOLANA_RPC_URL=<Alchemy HTTPS endpoint>
SOLANA_WS_URL=<Alchemy WSS endpoint>
NEXT_PUBLIC_SUPABASE_URL=<existing value>
SUPABASE_SERVICE_ROLE_KEY=<existing value>
```

`ALCHEMY_RPC_URL` and `ALCHEMY_WS_URL` remain supported by the shared connection helper, but the provider-neutral names are preferred.

Optional limits:

```text
MOONSHOT_HEARTBEAT_MS=30000
MOONSHOT_SUBSCRIPTION_SYNC_MS=60000
MOONSHOT_MAX_QUEUE_DEPTH=200
MOONSHOT_MAX_MINTS_PER_TRANSACTION=8
```

## Deployment order

1. Merge only after tests and typecheck pass.
2. Apply `20260727123000_moonshot_scanner_phase1.sql` to Supabase.
3. Create a separate Railway service using `npm run moonshot-scanner`.
4. Copy the existing non-secret Supabase/RPC variable names into the service.
5. Keep `ENABLE_MOONSHOT_SCANNER=false` and confirm the safe disabled log.
6. Add one reviewed program ID.
7. Set `ENABLE_MOONSHOT_SCANNER=true`.
8. Confirm candidate records and latency for at least 24 hours before adding another program.

## Expected logs

Disabled:

```text
[moonshot-scanner] moonshot_scanner_v1_2026_07_27 disabled
```

Enabled:

```text
[moonshot-scanner] moonshot_scanner_v1_2026_07_27 starting in scanner-only mode; trades disabled
[moonshot-scanner] subscribed <program>…
[moonshot-scanner] observed <n> candidate mint(s)
```

## Revert

Code revert:

- Move `main` back to the commit immediately before the Moonshot merge, or revert the Moonshot merge commit.
- The permanent recovery branch is `backup/pre-moonshot-2026-07-27`.

Runtime revert:

- Set `ENABLE_MOONSHOT_SCANNER=false`, or stop/delete only the dedicated Moonshot Railway service.
- No other bot needs to be restarted.

Database revert:

The Phase 1 tables are isolated. Leave them in place for audit history, or explicitly drop only:

```sql
drop table if exists public.moonshot_candidates;
drop table if exists public.moonshot_scanner_state;
```

Do not run the drop unless the recorded scanner history is no longer needed.
