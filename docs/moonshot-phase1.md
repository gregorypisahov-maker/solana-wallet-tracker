# Moonshot Bot — Phase 1 Scanner

## Scope

Phase 1 is observation-only. It does not modify Legion, AI Discovery, AI Capital, the live executor, or any existing paper trade.

The dedicated process:

- polls selected Solana program addresses with `getSignaturesForAddress` through the existing provider-neutral HTTP connection;
- stores a per-program cursor and starts at "now" instead of replaying historical transactions;
- fetches each fresh confirmed transaction with bounded retries and global RPC pacing;
- extracts non-stable token mints touched by the transaction;
- records candidate and latency evidence in `moonshot_candidates`;
- writes polling health counters to `moonshot_scanner_state`;
- cannot open a paper or live position.

The database enforces `would_enter = false` during Phase 1.

## Why HTTP polling

Moonshot no longer depends on `logsSubscribe`, `SOLANA_WS_URL`, or `ALCHEMY_WS_URL`. This removes the stale-WebSocket-variable failure mode and works with any Solana provider that supports the standard HTTP RPC methods already used by the wallet monitor.

Program-level polling is intentionally bounded. On very busy programs, a poll can hit its signature cap and sample only the newest activity. The scanner records this as a dropped/backlog warning rather than spending unlimited RPC credits.

## Safety defaults

- `ENABLE_MOONSHOT_SCANNER` defaults to `false`.
- No launch-program address is hardcoded.
- Missing or invalid configuration produces a safe idle process, not a crash loop.
- First activation initializes each program cursor at the latest signature and skips history.
- Polling, RPC pacing, queue depth, signature age, and per-poll volume are capped.
- Duplicate signatures are suppressed.
- RPC failures are retried and then skipped.
- The process uses a separate Railway start command and imports no trade execution module.

## Railway start command

```text
npm run moonshot-scanner
```

## Required environment variables

```text
ENABLE_MOONSHOT_SCANNER=false
MOONSHOT_PROGRAM_IDS=<comma-separated Solana program IDs>
SOLANA_RPC_URL=<Alchemy HTTPS endpoint>
NEXT_PUBLIC_SUPABASE_URL=<existing value>
SUPABASE_SERVICE_ROLE_KEY=<existing value>
```

`ALCHEMY_RPC_URL` remains supported by the shared connection helper. No WebSocket variable is required by Moonshot v2.

Optional limits:

```text
MOONSHOT_HEARTBEAT_MS=30000
MOONSHOT_POLL_INTERVAL_MS=15000
MOONSHOT_RPC_MIN_INTERVAL_MS=250
MOONSHOT_MAX_SIGNATURES_PER_POLL=25
MOONSHOT_MAX_SIGNATURE_AGE_MS=120000
MOONSHOT_MAX_QUEUE_DEPTH=200
MOONSHOT_MAX_MINTS_PER_TRANSACTION=8
```

## Deployment order

1. Merge only after tests and typecheck pass.
2. Apply `20260727160000_moonshot_http_polling.sql` to Supabase.
3. Keep the dedicated Railway service start command as `npm run moonshot-scanner`.
4. Keep the existing Alchemy HTTPS RPC and Supabase variables.
5. `SOLANA_WS_URL` and `ALCHEMY_WS_URL` are irrelevant to Moonshot v2 and may be removed from that dedicated service.
6. Keep `ENABLE_MOONSHOT_SCANNER=false` until the migration is present.
7. Add one reviewed program ID, then set `ENABLE_MOONSHOT_SCANNER=true`.
8. Confirm `intake_mode=http_polling`, increasing `polls_completed`, candidate records, and acceptable RPC usage before adding another program.

## Expected logs

Disabled:

```text
[moonshot-scanner] moonshot_scanner_v2_http_polling_2026_07_27 disabled
```

Enabled:

```text
[moonshot-scanner] moonshot_scanner_v2_http_polling_2026_07_27 starting in scanner-only HTTP polling mode; trades disabled
[moonshot-scanner] cursor initialized <program>…; historical transactions skipped
[moonshot-scanner] observed <n> candidate mint(s)
```

## Revert

Code revert:

- Revert the Moonshot HTTP polling commit.
- The permanent recovery branch is `backup/pre-moonshot-2026-07-27`.

Runtime revert:

- Set `ENABLE_MOONSHOT_SCANNER=false`, or stop/delete only the dedicated Moonshot Railway service.
- No other bot needs to be restarted.

Database revert:

The added polling columns are isolated health metadata. They may remain in place after a code revert. Do not drop `moonshot_candidates` or `moonshot_scanner_state` unless the recorded scanner history is intentionally being removed.
