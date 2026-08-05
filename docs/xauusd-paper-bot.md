# XAU/USD paper bot

This service is a separate, paper-only gold strategy for Railway. It does not submit broker orders and does not modify the active Solana service.

## Data source

The bot uses the Twelve Data REST API for `XAU/USD` 15-minute OHLC data.

One `/time_series` request supplies both:

- completed candles for the strategy; and
- the latest available midpoint used for paper position management.

Twelve Data does not provide bid/ask values for this feed. The bot therefore applies the configured `GOLD_PAPER_SPREAD_USD` around the latest midpoint. Longs enter at the synthetic ask and exit at the synthetic bid; shorts do the opposite. This spread is a paper-accounting assumption, not a claim that a future broker will offer the same execution.

The default two-minute polling interval uses about 720 API requests per 24 hours, leaving headroom under the Basic plan's 800-request daily allowance. Railway restarts and manual testing also consume requests, so do not reduce the interval on the free plan.

## Strategy v1

Strategy: `xauusd_m15_pullback_v1_2026_08_05`

- Completed 15-minute candles only.
- EMA20 / EMA50 trend filter.
- Entry after a pullback touches EMA20 and the next completed candle reclaims/rejects it in the trend direction.
- ATR(14) stop at 1.5 ATR.
- Default target at 2R.
- Default trading window: 06:00–20:00 UTC.
- One open position maximum.
- No martingale, grid, averaging down, or live order code.

This is a testable starting hypothesis, not a claim of profitability.

## Risk controls

Defaults:

- Synthetic starting balance: `$10,000`.
- Risk per trade: `0.25%` of current paper balance.
- Daily realized loss lock: `1%` from the UTC day starting balance.
- Maximum paper position: `5` gold units.
- Synthetic paper spread: `$0.50` total.
- Entry rejected when spread is more than `0.12 × ATR`.
- Stale market data is rejected.
- A database partial unique index enforces one open position.
- Closing a position and updating paper balance are atomic in Supabase.
- `GOLD_LIVE_ENABLED=true` causes startup to fail intentionally.

## Required setup

1. Create a Twelve Data account and obtain an API key.
2. Confirm the key can retrieve `XAU/USD` with `interval=15min`.
3. Apply `supabase/migrations/20260805220000_add_xauusd_paper_bot.sql`.
4. Create a new Railway service from this repository and use the start command:

   `npx tsx gold-bot/entrypoint.ts`

5. Copy the shared Supabase and Telegram variables from the existing Railway service.
6. Add:

   - `TWELVE_DATA_API_KEY`
   - `TWELVE_DATA_SYMBOL=XAU/USD`
   - `GOLD_LIVE_ENABLED=false`

The remaining settings and conservative defaults are documented in `.env.example`.

Never paste the Twelve Data API key into chat, GitHub, screenshots, or client-side dashboard code. Store it directly in Railway Variables.

## Validation

Run:

- `node --import tsx --test gold-bot/*.test.ts`
- `npx tsc -p gold-bot/tsconfig.json --pretty false`
- `npm run build`

The repository also contains `.github/workflows/validate-gold-paper.yml`.

## Paper-validation gate before any live executor

Do not add live order submission until the paper bot has at least 200 closed trades and has been reviewed for:

- net result after the configured paper spread;
- maximum drawdown;
- profit factor;
- average winner and loser;
- performance by hour and market regime;
- API outages, rate limits, stale prices, Railway restarts, and database recovery;
- whether results remain acceptable on unseen data and a forward-demo period.

A future live executor must use the real broker's contract size, bid/ask prices, fees, slippage, account rules, and stop-distance requirements. Twelve Data is market data only and cannot execute trades.
