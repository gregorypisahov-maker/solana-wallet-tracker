from pathlib import Path
from textwrap import dedent

executor_path = Path("live-executor/liveExecutor.ts")
executor = executor_path.read_text()

import_anchor = 'import { evaluateLiveEntrySafety } from "./liveSafety";\n'
new_import = 'import { evaluateLiveEntryTiming } from "./liveEntryTiming";\n'
if import_anchor not in executor:
    raise SystemExit("Expected liveSafety import anchor was not found")
if new_import not in executor:
    executor = executor.replace(import_anchor, import_anchor + new_import, 1)

max_age_anchor = dedent(
    '''\
    const SOURCE_ENTRY_MAX_AGE_MS = Math.max(
      10_000,
      Number(process.env.LIVE_SOURCE_ENTRY_MAX_AGE_MS) || 20_000
    );
    '''
)
skew_constant = "const SOURCE_ENTRY_CLOCK_SKEW_TOLERANCE_MS = 5_000;\n"
if max_age_anchor not in executor:
    raise SystemExit("Expected SOURCE_ENTRY_MAX_AGE_MS anchor was not found")
if skew_constant not in executor:
    executor = executor.replace(max_age_anchor, max_age_anchor + skew_constant, 1)

process_start = executor.find("async function processOnce(): Promise<void>")
if process_start < 0:
    raise SystemExit("processOnce was not found")
block_start = executor.find('    if (signal.side === "buy") {', process_start)
safety_anchor = "      const safety = await evaluateBuySignalSafety(signal);"
block_end = executor.find(safety_anchor, block_start)
if block_start < 0 or block_end < 0:
    raise SystemExit("Buy timing block boundaries were not found")
old_block = executor[block_start:block_end]
for required_anchor in (
    "signal.metadata?.source_opened_at",
    "entry_window_missed_no_chase",
    "SOURCE_ENTRY_MAX_AGE_MS",
):
    if required_anchor not in old_block:
        raise SystemExit(
            f"Expected anchor {required_anchor!r} missing from buy timing block; refusing edit"
        )

new_block = dedent(
    '''\
        if (signal.side === "buy") {
          const sourceTiming = evaluateLiveEntryTiming(
            signal,
            SOURCE_ENTRY_MAX_AGE_MS,
            Date.now(),
            SOURCE_ENTRY_CLOCK_SKEW_TOLERANCE_MS
          );
          console.log(
            `[live-executor] entry timing ${signal.token_symbol ?? signal.mint}: ` +
              `timestampField=${sourceTiming.field ?? "none"} ` +
              `sourceTimestamp=${sourceTiming.timestamp ?? "invalid"} ` +
              `sourceAgeMs=${sourceTiming.sourceAgeMs ?? "invalid"} ` +
              `rawSourceAgeMs=${sourceTiming.rawAgeMs ?? "invalid"} ` +
              `maximumAgeMs=${SOURCE_ENTRY_MAX_AGE_MS}`
          );
          if (
            !sourceTiming.valid ||
            sourceTiming.tooFarInFuture ||
            sourceTiming.expired
          ) {
            await reject(signal, "entry_window_missed_no_chase", {
              sourceTimestampField: sourceTiming.field,
              sourceTimestamp: sourceTiming.timestamp,
              sourceAgeMs: sourceTiming.sourceAgeMs,
              rawSourceAgeMs: sourceTiming.rawAgeMs,
              maximumAgeMs: SOURCE_ENTRY_MAX_AGE_MS,
              clockSkewToleranceMs: SOURCE_ENTRY_CLOCK_SKEW_TOLERANCE_MS,
            });
            return;
          }

    '''
)
executor = executor[:block_start] + new_block + executor[block_end:]
executor_path.write_text(executor)

Path("live-executor/liveEntryTiming.ts").write_text(
    dedent(
        '''\
        export type LiveEntryTimestampField =
          | "source_opened_at"
          | "decision_at"
          | "created_at";

        type LiveEntryTimingSignal = {
          created_at: string;
          metadata: Record<string, unknown> | null;
        };

        export type LiveEntryTimingResult = {
          field: LiveEntryTimestampField | null;
          timestamp: string | null;
          rawAgeMs: number | null;
          sourceAgeMs: number | null;
          valid: boolean;
          tooFarInFuture: boolean;
          expired: boolean;
        };

        export function evaluateLiveEntryTiming(
          signal: LiveEntryTimingSignal,
          maximumAgeMs: number,
          nowMs = Date.now(),
          clockSkewToleranceMs = 5_000
        ): LiveEntryTimingResult {
          const candidates: Array<[LiveEntryTimestampField, unknown]> = [
            ["source_opened_at", signal.metadata?.source_opened_at],
            ["decision_at", signal.metadata?.decision_at],
            ["created_at", signal.created_at],
          ];

          for (const [field, candidate] of candidates) {
            if (typeof candidate !== "string" || !candidate.trim()) continue;
            const parsedAtMs = Date.parse(candidate);
            if (!Number.isFinite(parsedAtMs)) continue;

            const rawAgeMs = nowMs - parsedAtMs;
            const tooFarInFuture = rawAgeMs < -clockSkewToleranceMs;
            const sourceAgeMs =
              rawAgeMs < 0 && !tooFarInFuture ? 0 : rawAgeMs;
            return {
              field,
              timestamp: candidate,
              rawAgeMs,
              sourceAgeMs,
              valid: true,
              tooFarInFuture,
              expired: sourceAgeMs > maximumAgeMs,
            };
          }

          return {
            field: null,
            timestamp: null,
            rawAgeMs: null,
            sourceAgeMs: null,
            valid: false,
            tooFarInFuture: false,
            expired: false,
          };
        }
        '''
    )
)

Path("lib/liveEntryTiming.test.ts").write_text(
    dedent(
        '''\
        import assert from "node:assert/strict";
        import test from "node:test";
        import { evaluateLiveEntryTiming } from "../live-executor/liveEntryTiming";

        const now = Date.parse("2026-07-28T20:20:39.512Z");
        const maxAgeMs = 45_000;

        test("accepts a trigger signal using decision_at", () => {
          const result = evaluateLiveEntryTiming(
            {
              created_at: "2026-07-28T20:20:37.512Z",
              metadata: { decision_at: "2026-07-28T20:20:37.512Z" },
            },
            maxAgeMs,
            now
          );
          assert.equal(result.field, "decision_at");
          assert.equal(result.sourceAgeMs, 2_000);
          assert.equal(result.expired, false);
          assert.equal(result.tooFarInFuture, false);
        });

        test("prefers source_opened_at over other timestamps", () => {
          const result = evaluateLiveEntryTiming(
            {
              created_at: "2026-07-28T20:20:20.000Z",
              metadata: {
                source_opened_at: "2026-07-28T20:20:38.512Z",
                decision_at: "2026-07-28T20:20:30.000Z",
              },
            },
            maxAgeMs,
            now
          );
          assert.equal(result.field, "source_opened_at");
          assert.equal(result.sourceAgeMs, 1_000);
        });

        test("falls back to created_at when metadata timestamps are unavailable", () => {
          const result = evaluateLiveEntryTiming(
            { created_at: "2026-07-28T20:20:37.512Z", metadata: {} },
            maxAgeMs,
            now
          );
          assert.equal(result.field, "created_at");
          assert.equal(result.sourceAgeMs, 2_000);
          assert.equal(result.expired, false);
        });

        test("skips an invalid higher-priority timestamp and uses a valid fallback", () => {
          const result = evaluateLiveEntryTiming(
            {
              created_at: "2026-07-28T20:20:37.512Z",
              metadata: {
                source_opened_at: "not-a-date",
                decision_at: "2026-07-28T20:20:36.512Z",
              },
            },
            maxAgeMs,
            now
          );
          assert.equal(result.field, "decision_at");
          assert.equal(result.sourceAgeMs, 3_000);
        });

        test("marks signals older than the configured window as expired", () => {
          const result = evaluateLiveEntryTiming(
            {
              created_at: "2026-07-28T20:19:00.000Z",
              metadata: { source_opened_at: "2026-07-28T20:19:00.000Z" },
            },
            maxAgeMs,
            now
          );
          assert.equal(result.expired, true);
          assert.ok((result.sourceAgeMs ?? 0) > maxAgeMs);
        });

        test("clamps small future clock skew to zero age", () => {
          const result = evaluateLiveEntryTiming(
            {
              created_at: "2026-07-28T20:20:42.512Z",
              metadata: { source_opened_at: "2026-07-28T20:20:42.512Z" },
            },
            maxAgeMs,
            now,
            5_000
          );
          assert.equal(result.rawAgeMs, -3_000);
          assert.equal(result.sourceAgeMs, 0);
          assert.equal(result.tooFarInFuture, false);
        });

        test("rejects timestamps too far in the future", () => {
          const result = evaluateLiveEntryTiming(
            {
              created_at: "2026-07-28T20:20:49.512Z",
              metadata: { source_opened_at: "2026-07-28T20:20:49.512Z" },
            },
            maxAgeMs,
            now,
            5_000
          );
          assert.equal(result.tooFarInFuture, true);
        });

        test("reports invalid when no timestamp can be parsed", () => {
          const result = evaluateLiveEntryTiming(
            {
              created_at: "invalid",
              metadata: { source_opened_at: "", decision_at: "also-invalid" },
            },
            maxAgeMs,
            now
          );
          assert.equal(result.valid, false);
          assert.equal(result.field, null);
        });
        '''
    )
)

migration_path = Path(
    "supabase/migrations/20260728235900_fix_live_entry_signal_timestamp.sql"
)
if migration_path.exists():
    raise SystemExit(f"Migration already exists: {migration_path}")
migration_path.write_text(
    dedent(
        '''\
        create or replace function public.emit_ai_discovery_live_buy_signal()
        returns trigger
        language plpgsql
        security definer
        set search_path = public
        as $$
        declare
          live_enabled boolean;
          live_halted boolean;
          live_max_position numeric;
        begin
          select enabled, halted, max_position_sol
            into live_enabled, live_halted, live_max_position
          from public.live_executor_state
          where id = 1;

          if coalesce(live_enabled, false) and not coalesce(live_halted, false) then
            insert into public.live_trade_signals (
              id, strategy, source_position_id, mint, token_symbol, side,
              requested_size_sol, max_slippage_bps, status, metadata, created_at
            ) values (
              gen_random_uuid(), 'ai_discovery', new.position_id, new.mint, new.token_symbol, 'buy',
              least(new.size_sol, coalesce(live_max_position, new.size_sol)), 100, 'pending',
              jsonb_build_object(
                'source', 'ai_discovery_decision_trigger',
                'decision_at', new.opened_at,
                'source_opened_at', new.opened_at,
                'paper_entry_price_usd', new.entry_price_usd,
                'pair_address', new.pair_address
              ),
              new.opened_at
            )
            on conflict (strategy, source_position_id, side) do nothing;
          end if;

          return new;
        end;
        $$;
        '''
    )
)
