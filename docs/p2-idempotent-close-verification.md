# P2 — AI discovery close idempotency

Reliability-only change. No entry, exit, sizing, score, friction, or AI Capital mirror values are changed.

## Investigation

The IPO incident was a second close attempt after a successful close:

- exactly one `ai_discovery_trades` row existed for IPO
- close time: 2026-07-26 06:54:48 UTC
- exit: take profit
- PnL: +0.018714785073216833 SOL
- no matching open position remained

## Verify after deploy

1. AI discovery worker starts normally.
2. Existing constants remain unchanged.
3. Normal closes still create one trade row, remove the position, update state once, and send one Telegram close notification.
4. A stale open position whose trade row already exists is deleted and logs:
   `[ai-discovery-trader] close already recorded for <token>`
5. A duplicate-key conflict does not credit bankroll twice and does not remain open indefinitely.
