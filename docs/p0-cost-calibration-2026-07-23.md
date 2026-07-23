# P0 paper execution-cost calibration — 2026-07-23

Cost model version: `p0_jupiter_pumpswap_jito_2026_07_23_v2`

This document records the inputs used to replace the old implicit price haircut with explicit, auditable execution costs. It is a paper-trading model, not a claim that every future transaction will receive these exact fills.

## Calibration inputs

### Jupiter 0.2 SOL quote sample

Quotes were pulled on 2026-07-23 for recent strategy mints. A 0.001 SOL quote was taken immediately beside each 0.2 SOL quote to isolate the size-dependent part of Jupiter's reported price impact.

| Token | Mint prefix | Live pool liquidity | Incremental impact at 0.2 SOL |
|---|---:|---:|---:|
| Cricket | `J33WbC…` | $17,781.57 | 0.1608% |
| ARRR | `5u83ee…` | $31,804.81 | 0.0996% |
| SUNUSI | `2vvw3c…` | $33,720.91 | 0.0944% |
| normoids | `57HrLU…` | $36,701.31 | 0.0859% |

DUCK (`2E9ne8…`) was also quoted, but its live liquidity had fallen to about $4,015, outside the requested $15k–$60k calibration band. Its much larger impact was retained as a sanity check but excluded from the central coefficient.

The in-band sample is represented by:

```text
slippage_pct = 2.0 × (trade_notional_usd / pool_liquidity_usd)
slippage_sol = trade_notional_sol × slippage_pct
```

The coefficient and liquidity are applied separately on entry and exit. Missing or non-positive liquidity fails closed.

### Network fee, priority fee and Jito tip

A Jupiter swap-build request for a 0.2 SOL PumpSwap route returned these priority-fee estimates:

| Priority level | Priority fee |
|---|---:|
| medium | 94,606 lamports |
| high | 225,430 lamports |
| very high | 2,053,053 lamports |

The model uses the `high` priority estimate. Jito's live tip-floor endpoint at `2026-07-23 12:40:34 UTC` reported a 99th-percentile landed tip of `99,800` lamports. Jito also recommends allocating roughly 70% of the total send budget to priority fee and 30% to tip; applying that split to the selected priority fee independently produces nearly the same tip.

```text
Solana base fee       5,000 lamports
Jupiter priority    225,430 lamports
Jito tip             99,800 lamports
------------------------------------
network total       330,230 lamports = 0.00033023 SOL per transaction
```

Each component and the total override are configurable because congestion and tip auctions change.

### Swap fee

The model uses `1.25%` per side, the conservative PumpSwap canonical-pool tier applicable to the low-market-cap band being targeted. This is configurable.

### Failed entry rate

The initial failed-entry rate is `5%`.

This is an explicit scenario assumption, not measured production telemetry: the project has not executed real-money swaps and therefore has no honest failure-rate sample. A failed entry pays one full network cost, writes a `paper_failed_entries` row, and opens no position. The value must be recalibrated from actual execution telemetry before any real-money readiness claim.

## Runtime configuration

| Environment variable | Default |
|---|---:|
| `PAPER_COST_MODEL_ENABLED` | `true` |
| `PAPER_BASE_FEE_SOL_PER_TX` | `0.000005` |
| `PAPER_PRIORITY_FEE_SOL_PER_TX` | `0.00022543` |
| `PAPER_JITO_TIP_SOL_PER_TX` | `0.0000998` |
| `PAPER_NETWORK_COST_SOL_PER_TX` | component sum: `0.00033023` |
| `PAPER_SWAP_FEE_PCT_PER_SIDE` | `0.0125` |
| `PAPER_SLIPPAGE_LIQUIDITY_COEFFICIENT` | `2.0` |
| `PAPER_COST_SOL_USD_REFERENCE` | `76.6981212318335` |
| `PAPER_FAILED_TRANSACTION_RATE` | `0.05` |

The cost model defaults on after the successful P0 backtest, so new paper trades cannot silently return to optimistic accounting. Setting `PAPER_COST_MODEL_ENABLED=false` restores the existing legacy friction behavior as an emergency rollback. With the model on, MAIN and TIERED stop applying the hidden 0.6%-per-side price haircut and instead write explicit gross and net accounting. SHADOW uses the same explicit model.

## Historical backfill result

Results are grouped by logical position, so ladder partial sells are not counted as separate trades. The `before` columns below are the values the simulator reported before P0; `after` is net of base/priority/tip network costs, swap fees, liquidity-scaled slippage, and the expected 5% failed-entry network cost.

| Strategy | Logical positions | P&L before P0 | Net P&L after costs | Net per position | PF before | PF after | Common-size break-even |
|---|---:|---:|---:|---:|---:|---:|---:|
| MAIN | 194 | +0.421500 SOL | **−0.686547 SOL** | −0.003539 SOL | 1.115 | **0.841** | none |
| SHADOW | 52 | +0.688747 SOL | **+0.161522 SOL** | +0.003106 SOL | 1.552 | **1.102** | 0.0517 SOL minimum; model turns negative above ~0.8343 SOL |
| TIERED | 97 | −0.019400 SOL | **−0.826921 SOL** | −0.008525 SOL | 0.993 | **0.726** | none |
| SCALP* | 63 | −0.191554 SOL | **−0.396524 SOL** | −0.006294 SOL | 0.586 | **0.329** | none |

`*` SCALP is a modeled report-only result in this P0 ticket. Its storage/runtime was not changed because the requested schema scope was MAIN, SHADOW, and TIERED.

The `gross_pnl_sol` backfill removes MAIN/TIERED's old hidden 0.6%-per-side price haircut before applying explicit costs. Therefore the raw price-only gross totals in the database are higher than the legacy displayed P&L. The comparison above intentionally uses the previously displayed simulator result as “before P0,” because that is the number users had been relying on.

## Decision

- MAIN does not clear realistic modeled costs.
- TIERED and SCALP remain negative.
- SHADOW remains positive, but its profit factor falls to 1.102, below the existing 1.4 live-readiness requirement.
- P1–P5 must remain disabled until separately backtested against this net-of-cost model.
- No real-money readiness claim is supported by these results.
