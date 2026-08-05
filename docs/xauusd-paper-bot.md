# XAUUSD paper bot

This service is a separate, paper-only gold strategy for Railway. It does not submit broker orders and does not modify the active Solana service.

## Data source

The bot uses the OANDA v20 REST API for:

- the account-specific tradable instrument list;
- completed midpoint candles;
- current account-specific bid and ask prices.

The default API instrument is `XAU_USD`. Availability and exact instrument details are validated against the configured OANDA account at startup.

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
- Maximum position: `5` OANDA units.
- Entry rejected when spread is more than `0.12 × ATR`.
- Stale or non-tradeable quotes are rejected.
- Existing positions are priced out at bid for longs and ask for shorts.
- A database partial unique index enforces one open position.
- Closing a position and updating paper balance are atomic in Supabase.
- `GOLD_LIVE_ENABLED=true` causes startup to fail intentionally.

## Required setup

1. Create an OANDA practice account that exposes gold through its v20 REST API.
2. Apply `supabase/migrations/20260805220000_add_xauusd_paper_bot.sql`.
3. Create a new Railway service from this repository and use the start command:

   `npm run gold-paper`

4. Copy the shared Supabase and Telegram variables from the existing Railway service.
5. Add:

   - `OANDA_API_TOKEN`
   - `OANDA_ACCOUNT_ID`
   - `OANDA_ENVIRONMENT=practice`
   - `OANDA_INSTRUMENT=XAU_USD`
   - `GOLD_LIVE_ENABLED=false`

The remaining settings and conservative defaults are documented in `.env.example`.

## Validation

Run:

- `npm run gold-test`
- `npx tsc -p gold-bot/tsconfig.json --pretty false`

The branch also contains `.github/workflows/validate-gold-paper.yml`.

## Paper-validation gate before any live executor

Do not add live order submission until the paper bot has at least 200 closed trades and has been reviewed for:

- net result after the actual recorded spread;
- maximum drawdown;
- profit factor;
- average winner and loser;
- performance by hour and market regime;
- API outages, stale prices, Railway restarts, and database recovery;
- whether results remain acceptable on unseen data and a forward demo period.
