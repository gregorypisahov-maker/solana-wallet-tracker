# Solana Smart Wallet Tracker

A Solana intelligence and paper-trading system built around **Champion research** and the **Jijo signer-verified wallet copier**. The current production bot is `single-bot/heliusSniperApp.ts` and persists state in Supabase.

## Current architecture

### Champion research
- Scans established Solana pools from GeckoTerminal.
- Filters for liquidity, market-cap range, pool age, momentum, volume and buy/sell flow.
- Scores candidates from 0–100.
- Stores every accepted/rejected candidate in `champion_candidates`.
- Measures outcomes at 60s, 180s, 300s, 900s and 1800s so the strategy can be evaluated instead of guessed.

### Champion paper trader
- Uses the research candidates rather than blindly trading every discovery.
- Default paper position size: 0.2 SOL.
- Maximum 3 concurrent positions and 15 daily entries.
- Default target: +10%; hard stop: -4%; trailing logic arms after +6%.
- Performs a Jupiter buy/sell quote check before opening a paper trade and rejects candidates whose conservative round-trip cost is above the configured limit.
- Persists positions, trades, bankroll and strategy state in Supabase.
- Sends operational alerts to Telegram.

### Jijo wallet copier
- Watches the configured target wallet and requires the target wallet to be a transaction signer before accepting an event as a trade.
- Detects buy/sell direction from SOL and token balance changes.
- Supports `observe` and gated `live` execution modes.
- Live execution requires all runtime arming flags plus database state gates; do not enable it until paper/observation results have been independently reviewed.
- Has copy ratio, maximum position, maximum open positions, daily entry/loss limits, slippage, reserve and source-age controls.
- Records detected events, copied positions and execution results in Supabase.

### Dashboard
The Express dashboard exposes service health, Champion paper performance, open positions, recent trades, research candidates and Jijo copier status. It is intended for private/controlled deployment.

## Production entrypoint

Use the explicit production command for the current combined bot:

```bash
npm run production-bot
```

`npm run single-bot` is kept as an equivalent alias.

The combined service starts Helius preflight, Champion research, Champion paper trading, the Jijo watcher and the dashboard. Legacy service commands remain in `package.json` only for compatibility and are intentionally disabled by `scripts/retired-service.mjs`.

## Environment

Keep all secrets server-side. At minimum, the active Solana/Jijo service needs the Supabase service-role credentials, Helius credentials and Telegram credentials used by the imported modules. Live execution additionally requires the explicit live-trading environment gates and whatever wallet/executor secrets are required by `lib/liveWallet`.

**Never commit:** private keys, seed phrases, API tokens, Supabase service-role keys, Telegram bot tokens or live-execution secrets.

## Verification

Run the full local verification suite before deploying:

```bash
npm ci
npm run verify
```

`npm run verify` performs:

1. TypeScript typecheck
2. Automated tests
3. Next.js production build

For the production bot itself:

```bash
npm run production-bot
```

## Safety model

The repository contains both paper-trading and live-capable infrastructure. Treat these as different risk levels.

**Default recommendation:** keep Champion paper-only and Jijo in `observe` mode until the recorded results demonstrate a durable edge after realistic execution costs.

The Jijo runtime has multiple independent live gates. A process restart must not be treated as permission to trade. Live execution should be enabled only deliberately and with small capital first.

## Supabase

The main backend project stores strategy state, candidate observations, paper positions/trades and Jijo copy events/positions. Database migrations live under `supabase/`.

If the Supabase project cannot be reached from the current network, do not fabricate database status. Check the Supabase dashboard/connection and retry the query before changing production state.

## Useful commands

```bash
npm run production-bot   # current combined Solana service
npm run typecheck        # TypeScript only
npm test                 # automated tests
npm run verify           # typecheck + tests + production build
npm run build            # Next.js build
npm run dev              # Next.js development server
```

## Project goal

The objective is not to accumulate more trading features. The objective is to turn the existing data pipeline into a measurable system:

**detect → score → paper trade/observe → measure execution reality → prove expectancy → only then consider live capital or a paid product.**
