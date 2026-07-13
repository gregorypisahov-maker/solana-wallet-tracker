# Solana Smart Wallet Tracker

Paper-trading-only Solana wallet monitor with Telegram alerts and a protected, view-only live dashboard. It never signs transactions, holds a private key, or executes real trades.

## What runs where

- **Web service (Vercel or Railway):** `npm run build` then `npm start`
- **Monitor service (Railway):** `npm run worker`
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
- The monitor uses paginated signature reads, bounded concurrent wallet polling, and non-overlapping monitor/position loops.
- Supabase failures throw instead of silently pretending state was saved.
- Partial sells contribute to one logical position; the consecutive-loss counter changes only when that full position closes.
- The alert score is 0–100, so the corrected default gate is `MIN_SCORE_FOR_ALERT=50`. Override it explicitly only after reviewing paper results.

## Telegram commands

- `/paperstats`
- `/walletstats`
- `/exitstats`
- `/scorestats`
- `/resume`

Only messages from `TELEGRAM_CHAT_ID` are accepted.
