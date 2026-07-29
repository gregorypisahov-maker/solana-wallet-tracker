# Helius Intelligence Shadow Worker

This service is isolated from trading execution. Version 1 only observes current `market_opportunities`, calls Helius for a capped number of high-score candidates, and writes snapshots to dedicated tables.

## Railway start command

```bash
npm run helius-intelligence
```

## Required variables

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
HELIUS_API_KEY=...
HELIUS_INTELLIGENCE_MODE=shadow
```

## Recommended initial limits

```bash
HELIUS_MONTHLY_CREDIT_LIMIT=8500000
HELIUS_DAILY_CREDIT_LIMIT=275000
HELIUS_HOURLY_CREDIT_LIMIT=12000
INTELLIGENCE_MIN_AI_SCORE=78
INTELLIGENCE_MAX_CANDIDATES_PER_CYCLE=3
INTELLIGENCE_MAX_DEEP_ANALYSES_PER_HOUR=30
INTELLIGENCE_CACHE_TTL_SECONDS=120
```

## Rollback

Set `HELIUS_INTELLIGENCE_MODE=off` or stop/delete only this Railway service. No existing trader reads these tables, and v1 cannot execute or block a trade.

## Safety limitations

Raw largest-token-account concentration is stored only as a measurement. It includes unclassified pool vaults and burn accounts and must not become an enforcement rule without holder classification and forward validation.
