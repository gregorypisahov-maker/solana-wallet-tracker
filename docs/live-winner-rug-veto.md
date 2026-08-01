# Live winner-aligned rug veto

This runtime patch keeps the AI discovery strategy as the entry selector while the live layer acts as a rug and sellability veto.

## Evidence used

The six genuine catastrophic discovery events in production history (Grok, Papoi, PIPEDOG, Grvt, and two XPLK events) were all entered before 90 minutes of pool age. Age alone was not used as a hard block because many profitable paper trades were also younger than 90 minutes.

The historical rug-pattern veto applies only to non-canonical PumpSwap pools whose LP state remains unresolved. It requires all of the following:

- pool age below 90 minutes;
- one-hour price appreciation of at least 35%; and
- at least one weak-participation signal: fewer than 100 five-minute buyers, buy ratio at or below 0.57, or the existing `possible_churn_or_fake_volume` risk.

The replay query used during review blocked all six known catastrophic events. It is not a guarantee against future rugs.

## Live behavior

- Canonical Pump migration pools are recognized from the official Pump/PumpSwap PDA derivation and treated as burned-liquidity pools.
- Explicitly unlocked/removable liquidity remains blocked.
- Mature unresolved pools (at least 90 minutes old) can use the configured live size after all normal checks pass.
- Younger unresolved pools can use at most 0.03 SOL and must pass stricter liquidity, activity, concentration, price-impact, and round-trip checks.
- The executor now applies the approved probation size before claiming and executing the order.
- The default live liquidity floor is 40,000 USD, which retains the historical USOP-style real winner while sellability checks remain enforced.
