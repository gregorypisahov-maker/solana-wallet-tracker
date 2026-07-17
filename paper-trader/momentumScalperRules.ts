export const SCALP_RULES = {
  startingBankrollSol: 1,
  fixedSizeSol: 0.05,
  minLiquidityUsd: 35_000,
  minMarketCapUsd: 100_000,
  maxMarketCapUsd: 5_000_000,
  minFiveMinuteChangePct: 2,
  maxFiveMinuteChangePct: 6,
  minFifteenMinuteChangePct: 5,
  maxFifteenMinuteChangePct: 25,
  minFiveMinuteVolumeUsd: 2_500,
  minFiveMinuteTrades: 25,
  minFiveMinuteBuyers: 10,
  minBuySellRatio: 0.6,
  minPoolAgeMinutes: 60,
  minimumSignalScore: 45,
  entryFrictionPct: 0.006,
  exitFrictionPct: 0.006,
  takeProfitNetPct: 4,
  hardStopNetPct: -2.5,
  trailingActivationNetPct: 1.8,
  trailingGivebackPct: 1.2,
  maxHoldMinutes: 7,
  cooldownMinutes: 30,
  maxDailyEntries: 8,
  maxDailyLossSol: 0.01,
  maxConsecutiveLosses: 4,
} as const;

export type ScalpCandidate = {
  mint: string;
  symbol: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  fiveMinuteChangePct: number;
  fifteenMinuteChangePct: number;
  fiveMinuteVolumeUsd: number;
  fiveMinuteBuys: number;
  fiveMinuteSells: number;
  fiveMinuteBuyers: number;
  poolAgeMinutes: number;
};

export type CandidateEvaluation = {
  accepted: boolean;
  score: number;
  reasons: string[];
  checks: FilterCheck[];
};

export type ScalpMarketConfirmation = {
  mint: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  fiveMinuteChangePct: number;
};

export type FilterCheck = {
  name: string;
  passed: boolean;
  actual: number | string | null;
  expected: string;
  reason: string | null;
};

export type ConfirmationEvaluation = {
  accepted: boolean;
  reasons: string[];
  checks: FilterCheck[];
};

export type ScalpExitReason =
  | "take_profit"
  | "hard_stop"
  | "trailing_stop"
  | "max_hold_time";

export type ExitDecision = {
  reason: ScalpExitReason;
  grossReturnPct: number;
  netReturnPct: number;
  netMultiple: number;
} | null;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const finiteOrZero = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function filterCheck(
  name: string,
  passed: boolean,
  actual: number | string | null,
  expected: string,
  reason: string
): FilterCheck {
  return { name, passed, actual, expected, reason: passed ? null : reason };
}

function reasonsFor(checks: FilterCheck[]): string[] {
  return [...new Set(checks.flatMap((check) => check.reason ? [check.reason] : []))];
}

export function calculateNetMultiple(
  priceMultiple: number,
  entryFrictionPct = SCALP_RULES.entryFrictionPct,
  exitFrictionPct = SCALP_RULES.exitFrictionPct
): number {
  if (!Number.isFinite(priceMultiple) || priceMultiple <= 0) return 0;
  return (
    priceMultiple *
    ((1 - exitFrictionPct) / (1 + entryFrictionPct))
  );
}

export function evaluateScalpCandidate(
  candidate: ScalpCandidate
): CandidateEvaluation {
  const requiredTextChecks = [
    ["mint_present", candidate?.mint, "candidate_mint_missing"],
    ["symbol_present", candidate?.symbol, "candidate_symbol_missing"],
    ["pair_present", candidate?.pairAddress, "candidate_pair_missing"],
  ] as const;
  const requiredNumbers = [
    ["priceUsd", candidate?.priceUsd, true],
    ["liquidityUsd", candidate?.liquidityUsd, true],
    ["marketCapUsd", candidate?.marketCapUsd, true],
    ["fiveMinuteChangePct", candidate?.fiveMinuteChangePct, false],
    ["fifteenMinuteChangePct", candidate?.fifteenMinuteChangePct, false],
    ["fiveMinuteVolumeUsd", candidate?.fiveMinuteVolumeUsd, false],
    ["fiveMinuteBuys", candidate?.fiveMinuteBuys, false],
    ["fiveMinuteSells", candidate?.fiveMinuteSells, false],
    ["fiveMinuteBuyers", candidate?.fiveMinuteBuyers, false],
    ["poolAgeMinutes", candidate?.poolAgeMinutes, false],
  ] as const;
  const fiveMinuteBuys = finiteOrZero(candidate?.fiveMinuteBuys);
  const fiveMinuteSells = finiteOrZero(candidate?.fiveMinuteSells);
  const trades = fiveMinuteBuys + fiveMinuteSells;
  const buySellRatio =
    fiveMinuteBuys / Math.max(1, fiveMinuteSells);
  const checks: FilterCheck[] = [
    ...requiredTextChecks.map(([name, value, reason]) =>
      filterCheck(name, typeof value === "string" && value.trim().length > 0, value ?? null, "non-empty string", reason)
    ),
    ...requiredNumbers.map(([name, value, positive]) =>
      filterCheck(
        `${name}_valid`,
        typeof value === "number" && Number.isFinite(value) && (!positive || value > 0),
        typeof value === "number" && Number.isFinite(value) ? value : null,
        positive ? "finite number > 0" : "finite number",
        `candidate_field_missing_or_invalid:${name}`
      )
    ),
    filterCheck("minimum_liquidity", candidate?.liquidityUsd >= SCALP_RULES.minLiquidityUsd, finiteOrZero(candidate?.liquidityUsd), `>= ${SCALP_RULES.minLiquidityUsd}`, "liquidity_below_35k"),
    filterCheck("minimum_market_cap", candidate?.marketCapUsd >= SCALP_RULES.minMarketCapUsd, finiteOrZero(candidate?.marketCapUsd), `>= ${SCALP_RULES.minMarketCapUsd}`, "market_cap_below_100k"),
    filterCheck("maximum_market_cap", candidate?.marketCapUsd <= SCALP_RULES.maxMarketCapUsd, finiteOrZero(candidate?.marketCapUsd), `<= ${SCALP_RULES.maxMarketCapUsd}`, "market_cap_above_5m"),
    filterCheck("minimum_5m_momentum", candidate?.fiveMinuteChangePct >= SCALP_RULES.minFiveMinuteChangePct, finiteOrZero(candidate?.fiveMinuteChangePct), `>= ${SCALP_RULES.minFiveMinuteChangePct}%`, "five_minute_momentum_too_low"),
    filterCheck("maximum_5m_momentum", candidate?.fiveMinuteChangePct <= SCALP_RULES.maxFiveMinuteChangePct, finiteOrZero(candidate?.fiveMinuteChangePct), `<= ${SCALP_RULES.maxFiveMinuteChangePct}%`, "five_minute_momentum_overheated"),
    filterCheck("minimum_15m_momentum", candidate?.fifteenMinuteChangePct >= SCALP_RULES.minFifteenMinuteChangePct, finiteOrZero(candidate?.fifteenMinuteChangePct), `>= ${SCALP_RULES.minFifteenMinuteChangePct}%`, "fifteen_minute_confirmation_too_low"),
    filterCheck("maximum_15m_momentum", candidate?.fifteenMinuteChangePct <= SCALP_RULES.maxFifteenMinuteChangePct, finiteOrZero(candidate?.fifteenMinuteChangePct), `<= ${SCALP_RULES.maxFifteenMinuteChangePct}%`, "fifteen_minute_move_overheated"),
    filterCheck("minimum_5m_volume", candidate?.fiveMinuteVolumeUsd >= SCALP_RULES.minFiveMinuteVolumeUsd, finiteOrZero(candidate?.fiveMinuteVolumeUsd), `>= ${SCALP_RULES.minFiveMinuteVolumeUsd}`, "five_minute_volume_too_low"),
    filterCheck("minimum_5m_trades", trades >= SCALP_RULES.minFiveMinuteTrades, trades, `>= ${SCALP_RULES.minFiveMinuteTrades}`, "five_minute_trades_too_low"),
    filterCheck("minimum_5m_buyers", candidate?.fiveMinuteBuyers >= SCALP_RULES.minFiveMinuteBuyers, finiteOrZero(candidate?.fiveMinuteBuyers), `>= ${SCALP_RULES.minFiveMinuteBuyers}`, "buyer_breadth_too_low"),
    filterCheck("minimum_buy_sell_ratio", buySellRatio >= SCALP_RULES.minBuySellRatio, buySellRatio, `>= ${SCALP_RULES.minBuySellRatio}`, "buy_flow_too_weak"),
    filterCheck("minimum_pool_age", candidate?.poolAgeMinutes >= SCALP_RULES.minPoolAgeMinutes, finiteOrZero(candidate?.poolAgeMinutes), `>= ${SCALP_RULES.minPoolAgeMinutes} minutes`, "pool_too_new"),
  ];

  const momentumScore =
    clamp(
      (finiteOrZero(candidate?.fiveMinuteChangePct) -
        SCALP_RULES.minFiveMinuteChangePct) /
        (SCALP_RULES.maxFiveMinuteChangePct -
          SCALP_RULES.minFiveMinuteChangePct),
      0,
      1
    ) * 25;
  const confirmationScore =
    clamp(finiteOrZero(candidate?.fifteenMinuteChangePct) / 15, 0, 1) * 20;
  const volumeScore =
    clamp(finiteOrZero(candidate?.fiveMinuteVolumeUsd) / 20_000, 0, 1) * 20;
  const breadthScore =
    clamp(finiteOrZero(candidate?.fiveMinuteBuyers) / 50, 0, 1) * 20;
  const flowScore = clamp(buySellRatio / 2, 0, 1) * 15;

  const score = Math.round(
    momentumScore +
      confirmationScore +
      volumeScore +
      breadthScore +
      flowScore
  );
  if (score < SCALP_RULES.minimumSignalScore) {
    checks.push(filterCheck("minimum_signal_score", false, score, `>= ${SCALP_RULES.minimumSignalScore}`, "signal_score_below_45"));
  } else {
    checks.push(filterCheck("minimum_signal_score", true, score, `>= ${SCALP_RULES.minimumSignalScore}`, "signal_score_below_45"));
  }

  const reasons = reasonsFor(checks);

  return {
    accepted: checks.every((check) => check.passed),
    score,
    reasons,
    checks,
  };
}

export function evaluateScalpConfirmation(
  candidate: ScalpCandidate,
  confirmation: ScalpMarketConfirmation
): ConfirmationEvaluation {
  const checks: FilterCheck[] = [
    filterCheck("selected_mint_matches_confirmation", Boolean(candidate?.mint) && candidate.mint === confirmation?.mint, confirmation?.mint ?? null, candidate?.mint ?? "selected candidate mint", "dex_mint_mismatch"),
    filterCheck("dex_pair_present", typeof confirmation?.pairAddress === "string" && confirmation.pairAddress.length > 0, confirmation?.pairAddress ?? null, "non-empty pair address", "dex_pair_missing"),
    filterCheck("dex_price_valid", Number.isFinite(confirmation?.priceUsd) && confirmation.priceUsd > 0, Number.isFinite(confirmation?.priceUsd) ? confirmation.priceUsd : null, "finite number > 0", "dex_price_invalid"),
    filterCheck("dex_liquidity_valid", Number.isFinite(confirmation?.liquidityUsd), Number.isFinite(confirmation?.liquidityUsd) ? confirmation.liquidityUsd : null, "finite number", "dex_liquidity_missing_or_invalid"),
    filterCheck("dex_market_cap_valid", Number.isFinite(confirmation?.marketCapUsd), Number.isFinite(confirmation?.marketCapUsd) ? confirmation.marketCapUsd : null, "finite number", "dex_market_cap_missing_or_invalid"),
    filterCheck("dex_5m_change_valid", Number.isFinite(confirmation?.fiveMinuteChangePct), Number.isFinite(confirmation?.fiveMinuteChangePct) ? confirmation.fiveMinuteChangePct : null, "finite number", "dex_five_minute_change_missing_or_invalid"),
    filterCheck("dex_minimum_liquidity", confirmation?.liquidityUsd >= SCALP_RULES.minLiquidityUsd, finiteOrZero(confirmation?.liquidityUsd), `>= ${SCALP_RULES.minLiquidityUsd}`, "dex_liquidity_below_35k"),
    filterCheck("dex_minimum_market_cap", confirmation?.marketCapUsd >= SCALP_RULES.minMarketCapUsd, finiteOrZero(confirmation?.marketCapUsd), `>= ${SCALP_RULES.minMarketCapUsd}`, "dex_market_cap_below_100k"),
    filterCheck("dex_maximum_market_cap", confirmation?.marketCapUsd <= SCALP_RULES.maxMarketCapUsd, finiteOrZero(confirmation?.marketCapUsd), `<= ${SCALP_RULES.maxMarketCapUsd}`, "dex_market_cap_above_5m"),
    filterCheck("dex_minimum_5m_momentum", confirmation?.fiveMinuteChangePct >= SCALP_RULES.minFiveMinuteChangePct, finiteOrZero(confirmation?.fiveMinuteChangePct), `>= ${SCALP_RULES.minFiveMinuteChangePct}%`, "dex_five_minute_momentum_too_low"),
    filterCheck("dex_maximum_5m_momentum", confirmation?.fiveMinuteChangePct <= SCALP_RULES.maxFiveMinuteChangePct, finiteOrZero(confirmation?.fiveMinuteChangePct), `<= ${SCALP_RULES.maxFiveMinuteChangePct}%`, "dex_five_minute_momentum_overheated"),
  ];
  const reasons = reasonsFor(checks);
  return { accepted: checks.every((check) => check.passed), reasons, checks };
}

export function configuredNetRewardRiskRatio(): number {
  return SCALP_RULES.takeProfitNetPct / Math.abs(SCALP_RULES.hardStopNetPct);
}

export function decideScalpExit(input: {
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  openedAtMs: number;
  nowMs: number;
}): ExitDecision {
  const {
    entryPriceUsd,
    currentPriceUsd,
    peakPriceUsd,
    openedAtMs,
    nowMs,
  } = input;
  if (
    !Number.isFinite(entryPriceUsd) ||
    entryPriceUsd <= 0 ||
    !Number.isFinite(currentPriceUsd) ||
    currentPriceUsd <= 0
  ) {
    return null;
  }

  const priceMultiple = currentPriceUsd / entryPriceUsd;
  const peakPriceMultiple =
    Math.max(currentPriceUsd, peakPriceUsd) / entryPriceUsd;
  const netMultiple = calculateNetMultiple(priceMultiple);
  const peakNetMultiple = calculateNetMultiple(peakPriceMultiple);
  const grossReturnPct = (priceMultiple - 1) * 100;
  const netReturnPct = (netMultiple - 1) * 100;
  const peakNetReturnPct = (peakNetMultiple - 1) * 100;
  const holdMinutes = Math.max(0, nowMs - openedAtMs) / 60_000;

  const result = (reason: ScalpExitReason): NonNullable<ExitDecision> => ({
    reason,
    grossReturnPct,
    netReturnPct,
    netMultiple,
  });

  if (netReturnPct <= SCALP_RULES.hardStopNetPct) {
    return result("hard_stop");
  }
  if (netReturnPct >= SCALP_RULES.takeProfitNetPct) {
    return result("take_profit");
  }
  if (
    peakNetReturnPct >= SCALP_RULES.trailingActivationNetPct &&
    netReturnPct <=
      peakNetReturnPct - SCALP_RULES.trailingGivebackPct
  ) {
    return result("trailing_stop");
  }
  if (holdMinutes >= SCALP_RULES.maxHoldMinutes) {
    return result("max_hold_time");
  }
  return null;
}
