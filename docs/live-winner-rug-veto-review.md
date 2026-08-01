# Review checklist

- [x] Paper AI remains the entry selector.
- [x] Explicit unlocked liquidity remains a hard block.
- [x] Canonical PumpSwap migration pool derivation follows official Pump/PumpSwap seeds.
- [x] Unknown young pools are automatically reduced to 0.03 SOL before execution.
- [x] Unknown mature pools may retain the configured 0.1 SOL maximum.
- [x] Historical young-pool rug pattern is a hard veto.
- [x] Existing Jupiter buy, sell, price-impact, and round-trip checks remain active.
- [x] Existing holder concentration, token authority, duplicate-symbol, deployer, daily-loss, and one-position limits remain active.
- [x] Generated runtime code is typechecked in GitHub Actions.
