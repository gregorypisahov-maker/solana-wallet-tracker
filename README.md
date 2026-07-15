# Solana Smart Wallet Tracker

Paper-trading-only Solana wallet monitor with Telegram alerts and a protected, view-only live dashboard. It never signs transactions, holds a private key, or executes real trades. Wallet activity arrives through one standard Helius WebSocket connection, with slow RPC reconciliation as a safety net.

## What runs where

- **Web service (Vercel or Railway):** `npm run build` then `npm start`
- **Monitor service (Railway):** `npm run worker`
- **Legacy monitor command:** `npm run paper-trader` (kept as an alias so existing Railway services continue to start the same TypeScript monitor)
- **Telegram command service (Railway):** `npm run telegram-bot`

Run exactly one Telegram command service. The monitor deliberately does not start the long-polling Telegram listener, preventing duplicate `getUpdates` consumers and unreliable `/resume` commands. The TypeScript paper trader is integrated into the monitor; the old standalone JavaScript trader is not a deployment service.

## Required environment variables

Copy `.env.example` and set these server-side only:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `HELIUS_RPC_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `VIEWER_SHARE_TOKEN` — at least 32 cryptographically random characters
- `DASHBOARD_ADMIN_PASSWORD` — required only by wallet mutation APIs

Generate safe secrets:

```bash
openssl rand -hex 32
```

Never expose `SUPABASE_SERVICE_ROLE_KEY`, the Telegram token, viewer token, or admin password in browser code or a public environment file.

## Database upgrade

Before deploying, paste the complete contents of `supabase/finish-job-migration.sql` into the Supabase SQL editor and run it once. The migration is idempotent and preserves existing rows.

Then apply the timestamped files in `supabase/migrations/` in order. They add the server-only Helius usage samples used by `/heliusstats` and remove only verified duplicate indexes.

Then backfill historical grouping and alert participants once:

```bash
npx tsx scripts/backfillPositionsIds.ts
npx tsx scripts/backfillAlertParticipants.ts
```

The first script warns if historical rows cannot be grouped safely. Review warnings rather than guessing.

## Local verification

```bash
npm ci
npm run typecheck
npm run build
npm run dev
```

Open the private dashboard once with:

```text
http://localhost:3000/?token=YOUR_VIEWER_SHARE_TOKEN
```

The token is exchanged for an HTTP-only cookie and removed from the URL. A friend can receive the same view-only link. Rotate `VIEWER_SHARE_TOKEN` to revoke every existing viewer session.

## Deployment order

1. Run the Supabase migration and both backfills.
2. Add the required environment variables to the web, monitor, and Telegram services as applicable.
3. Deploy the web service.
4. Deploy one monitor service with `npm run worker`.
5. Deploy one Telegram service with `npm run telegram-bot`.
6. Confirm Railway shows one worker startup message and one Telegram listener startup message.
7. Test `/paperstats` and `/resume` from the authorized Telegram chat.
8. Open the viewer URL and confirm the `Updated` time advances every 10 seconds.

## Security and behavior

- Dashboard reads use the server-side Supabase client; no service-role key reaches the browser.
- The dashboard contains no add/delete wallet controls.
- Existing wallet write endpoints require HTTP Basic auth with `DASHBOARD_ADMIN_PASSWORD`.
- Viewer and API reads require the replaceable share token cookie.
- A wallet with no cursor starts at its latest confirmed signature. Normal startup never replays historical swaps.
- Every inspected signature checkpoints its cursor immediately, so a Railway restart cannot restart a large backfill.
- The worker automatically creates one Helius Enhanced Webhook filtered to successful `SWAP` events for the active wallets. Its public receiver is the `helius-webhook` Supabase Edge Function, so it is not blocked by dashboard deployment protection. Helius charges one credit per delivered event, and the parsed balance changes avoid a `getTransaction` lookup for every non-trade wallet action. A standard WebSocket remains the automatic fallback if the webhook cannot activate.
- The Free-plan webhook budget monitors six wallets at a time: the four strongest trust scores stay in the core, and two exploration slots rotate through the remaining active wallets every six hours. All active wallets still receive signatures-only reconciliation, preserving broad paper learning while leaving room for traffic spikes under the monthly credit cap.
- After one complete 15-minute telemetry bucket, a one-way budget guard checks the recent projected burn every 15 minutes. If the projection exceeds 700,000 credits/month, it automatically reduces live webhook coverage (never below three wallets) and keeps at least one rotating exploration slot. It does not expand coverage automatically during the same worker run.
- A 15-minute signatures-only reconciliation keeps cursors current without refetching webhook-era transactions. Fallback RPC calls are globally paced with exponential 429 backoff, and duplicate signatures are suppressed in memory and Postgres.
- Operational usage samples are server-only and power `/heliusstats`; the estimate includes filtered webhook events, fallback RPC calls, and streamed bytes, but the Helius dashboard remains the billing source of truth.
- Both sides of a rapid buy/sell pair are marked as scalps, preventing an earlier scalp buy from creating a false signal.
- Monitor and position loops do not overlap with themselves.
- Supabase failures throw instead of silently pretending state was saved.
- Partial sells contribute to one logical position; the consecutive-loss counter changes only when that full position closes.
- The default alert gate is `MIN_SCORE_FOR_ALERT=8`, matching the paper trader’s validated entry filter. Override it explicitly only after reviewing paper results.

## Telegram commands

- `/paperstats`
- `/walletstats`
- `/exitstats`
- `/scorestats`
- `/heliusstats`
- `/readiness`
- `/resume`

Only messages from `TELEGRAM_CHAT_ID` are accepted.
