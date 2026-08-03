import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[token2022-safety] missing ${label}`);
  source = source.replace(before, after);
}

const recentAnchor = "const recentMints = new Map<string, number>();";
const constants = `const CLASSIC_SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_SAFETY_RPC_URL = required("HELIUS_RPC_URL");
const TOKEN_2022_MAX_IMMUTABLE_FEE_BPS = positiveNumber("MARKET_TOKEN_2022_MAX_IMMUTABLE_FEE_BPS", 100);
const TOKEN_2022_QUOTE_DELAY_MS = positiveInt("MARKET_TOKEN_2022_QUOTE_DELAY_MS", 1500);
const TOKEN_2022_MAX_QUOTE_SPREAD_PCT = positiveNumber("MARKET_TOKEN_2022_MAX_QUOTE_SPREAD_PCT", 0.75);
const TOKEN_2022_INSTANT_PROFIT_CONFIRM_PCT = positiveNumber("MARKET_TOKEN_2022_INSTANT_PROFIT_CONFIRM_PCT", 100.25);
${recentAnchor}`;
replaceOnce(recentAnchor, constants, "token constants");

const validateAnchor = "async function validateRoundTrip(candidate: Candidate, sizeUsdc: number): Promise<{ buyQuote: any; sellQuote: any; recoveryPct: number }> {";
const helpers = `function normalizedExtensionName(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extensionName(entry: any): string {
  return normalizedExtensionName(entry?.extension ?? entry?.type ?? entry?.name ?? "");
}

function collectNumbersByKey(value: any, keyNeedle: string, output: number[] = []): number[] {
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    if (normalizedExtensionName(key).includes(keyNeedle)) {
      const parsed = Number(child);
      if (Number.isFinite(parsed)) output.push(parsed);
    }
    if (child && typeof child === "object") collectNumbersByKey(child, keyNeedle, output);
  }
  return output;
}

function hasPresentAuthority(value: any, keyNeedle: string): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizedExtensionName(key);
    if (normalizedKey.includes(keyNeedle)) {
      if (typeof child === "string" && child.length > 20) return true;
      if (child && typeof child === "object" && Object.keys(child).length > 0) return true;
    }
    if (child && typeof child === "object" && hasPresentAuthority(child, keyNeedle)) return true;
  }
  return false;
}

async function inspectTokenSafety(mint: string): Promise<any> {
  const response = await fetch(TOKEN_SAFETY_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) throw new Error(`token_safety_rpc_failed_${response.status}`);
  const account = payload?.result?.value;
  if (!account) throw new Error("token_safety_mint_missing");
  const program = String(account.owner ?? "");
  if (program === CLASSIC_SPL_TOKEN_PROGRAM) {
    return { safe: true, standard: "classic-spl", program, extensions: [], warnings: [] };
  }
  if (program !== TOKEN_2022_PROGRAM) throw new Error(`unsupported_token_program_${program || "unknown"}`);

  const info = account?.data?.parsed?.info;
  if (!info || typeof info !== "object") throw new Error("token2022_mint_unparsed");
  const entries = Array.isArray(info.extensions) ? info.extensions : [];
  if (Number(account.space ?? 0) > 166 && entries.length === 0) {
    throw new Error("token2022_extensions_unreadable");
  }

  const safeNames = new Set([
    "metadatapointer",
    "tokenmetadata",
    "grouppointer",
    "groupmemberpointer",
    "tokengroup",
    "tokengroupmember",
    "immutableowner",
  ]);
  const blockedFragments = [
    "permanentdelegate",
    "transferhook",
    "nontransferable",
    "pausable",
    "confidential",
    "permissionedburn",
    "scaleduiamount",
    "interestbearing",
    "mintcloseauthority",
  ];
  const extensions: string[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    const name = extensionName(entry);
    if (!name || name === "uninitialized") continue;
    extensions.push(name);
    if (blockedFragments.some((fragment) => name.includes(fragment))) {
      throw new Error(`token2022_blocked_extension_${name}`);
    }
    if (name.includes("defaultaccountstate")) {
      if (JSON.stringify(entry).toLowerCase().includes("frozen")) {
        throw new Error("token2022_default_account_frozen");
      }
      warnings.push("default-account-state-initialized");
      continue;
    }
    if (name.includes("transferfeeconfig")) {
      const basisPoints = collectNumbersByKey(entry, "basispoints");
      const maximumBps = basisPoints.length ? Math.max(...basisPoints) : Number.POSITIVE_INFINITY;
      const mutable = hasPresentAuthority(entry, "transferfeeconfigauthority");
      if (mutable) throw new Error("token2022_mutable_transfer_fee");
      if (maximumBps > TOKEN_2022_MAX_IMMUTABLE_FEE_BPS) {
        throw new Error(`token2022_transfer_fee_${maximumBps}_bps`);
      }
      warnings.push(`immutable-transfer-fee-${maximumBps}-bps`);
      continue;
    }
    if (!safeNames.has(name)) throw new Error(`token2022_unknown_extension_${name}`);
  }

  return { safe: true, standard: "token-2022", program, extensions, warnings };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmToken2022RoundTrip(
  candidate: Candidate,
  sizeUsdc: number,
  tokenSafety: any,
  first: { buyQuote: any; sellQuote: any; recoveryPct: number },
): Promise<any> {
  if (tokenSafety.standard !== "token-2022") {
    return { validation: first, confirmation: { attempts: 1, recoveries: [first.recoveryPct], spreadPct: 0 } };
  }
  const attempts = [first];
  const targetAttempts = first.recoveryPct >= TOKEN_2022_INSTANT_PROFIT_CONFIRM_PCT ? 3 : 2;
  while (attempts.length < targetAttempts) {
    await delay(TOKEN_2022_QUOTE_DELAY_MS);
    attempts.push(await validateRoundTrip(candidate, sizeUsdc));
  }
  const recoveries = attempts.map((attempt) => attempt.recoveryPct);
  const spreadPct = Math.max(...recoveries) - Math.min(...recoveries);
  if (spreadPct > TOKEN_2022_MAX_QUOTE_SPREAD_PCT) {
    throw new Error(`token2022_unstable_quotes_${spreadPct.toFixed(2)}pct`);
  }
  if (Math.max(...recoveries) >= TOKEN_2022_INSTANT_PROFIT_CONFIRM_PCT && Math.min(...recoveries) < 100.10) {
    throw new Error("token2022_instant_profit_not_repeatable");
  }
  const validation = [...attempts].sort((a, b) => a.recoveryPct - b.recoveryPct)[0];
  return {
    validation,
    confirmation: {
      attempts: attempts.length,
      recoveries,
      spreadPct,
      conservativeRecoveryPct: validation.recoveryPct,
      instantProfitRepeated: Math.min(...recoveries) >= TOKEN_2022_INSTANT_PROFIT_CONFIRM_PCT,
    },
  };
}

${validateAnchor}`;
replaceOnce(validateAnchor, helpers, "token safety helpers");

const validationLine = "  const validation = await validateRoundTrip(candidate, tradeSizeUsdc);";
const extensionAwareValidation = `  const tokenSafety = await inspectTokenSafety(candidate.mint);
  const firstValidation = await validateRoundTrip(candidate, tradeSizeUsdc);
  const confirmedRoundTrip = await confirmToken2022RoundTrip(candidate, tradeSizeUsdc, tokenSafety, firstValidation);
  const validation = confirmedRoundTrip.validation;
  const quoteConfirmation = confirmedRoundTrip.confirmation;`;
replaceOnce(validationLine, extensionAwareValidation, "open-position validation");

replaceOnce(
  "        sizing,\n        reasons:",
  "        sizing,\n        tokenSafety,\n        quoteConfirmation,\n        reasons:",
  "trade safety metadata",
);

replaceOnce(
  "Size: ${tradeSizeUsdc.toFixed(2)} USDC\\nConfidence:",
  "Size: ${tradeSizeUsdc.toFixed(2)} USDC\\nToken standard: ${tokenSafety.standard}\\nConfidence:",
  "telegram token standard",
);

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-token2022-safety] applied");
