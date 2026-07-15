// Supabase Edge Function: public Helius receiver with custom authentication.
// JWT verification is disabled at deployment because Helius sends a derived
// bearer token rather than a Supabase user JWT.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const JSON_HEADERS = { "Content-Type": "application/json" };

interface TokenBalanceChange {
  mint?: string;
  userAccount?: string;
  rawTokenAmount?: { decimals?: number; tokenAmount?: string };
}

interface EnhancedTransaction {
  type?: string;
  signature?: string;
  timestamp?: number;
  fee?: number;
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: TokenBalanceChange[];
  }>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function tokenDelta(change: TokenBalanceChange): number {
  const raw = Number(change.rawTokenAmount?.tokenAmount ?? 0);
  const decimals = Number(change.rawTokenAmount?.decimals ?? 0);
  if (!Number.isFinite(raw) || !Number.isFinite(decimals)) return 0;
  return raw / 10 ** Math.max(0, decimals);
}

function extractTrades(
  transaction: EnhancedTransaction,
  trackedWallets: Set<string>
) {
  if (
    transaction.type !== "SWAP" ||
    !transaction.signature ||
    !Number.isFinite(transaction.timestamp)
  ) {
    return [];
  }

  const accountData = transaction.accountData ?? [];
  const feeSol = Math.max(0, Number(transaction.fee ?? 0)) / 1e9;
  const trades: Array<Record<string, unknown>> = [];

  for (const walletAddress of trackedWallets) {
    const nativeDelta =
      accountData
        .filter((row) => row.account === walletAddress)
        .reduce((sum, row) => sum + Number(row.nativeBalanceChange ?? 0), 0) /
      1e9;
    const deltas = new Map<string, number>();

    for (const row of accountData) {
      for (const change of row.tokenBalanceChanges ?? []) {
        if (
          change.userAccount !== walletAddress ||
          !change.mint ||
          change.mint === WSOL_MINT
        ) {
          continue;
        }
        deltas.set(
          change.mint,
          (deltas.get(change.mint) ?? 0) + tokenDelta(change)
        );
      }
    }

    let tokenMint: string | null = null;
    let largestDelta = 0;
    for (const [mint, delta] of deltas) {
      if (Math.abs(delta) > Math.abs(largestDelta)) {
        tokenMint = mint;
        largestDelta = delta;
      }
    }
    if (!tokenMint || largestDelta === 0) continue;

    const common = {
      walletAddress,
      signature: transaction.signature,
      tokenMint,
      tokenAmount: Math.abs(largestDelta),
      txTime: new Date(Number(transaction.timestamp) * 1_000),
    };
    if (largestDelta > 0 && nativeDelta < -feeSol) {
      trades.push({ ...common, side: "buy", solAmount: Math.abs(nativeDelta) });
    } else if (largestDelta < 0 && nativeDelta > 0) {
      trades.push({ ...common, side: "sell", solAmount: nativeDelta });
    }
  }
  return trades;
}

Deno.serve(async (request: Request) => {
  if (request.method === "GET") {
    return json({ ok: true, mode: "enhanced-swap-webhook" });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Server configuration unavailable" }, 500);
  }

  const expectedToken = await sha256Hex(
    `solana-wallet-tracker:helius-webhook:${serviceRoleKey}`
  );
  const expectedAuthorization = `Bearer ${expectedToken}`;
  if (
    !constantTimeEqual(
      request.headers.get("authorization") ?? "",
      expectedAuthorization
    )
  ) {
    return json({ error: "Unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(payload) || payload.length > 500) {
    return json({ error: "Invalid webhook batch" }, 400);
  }

  const databaseHeaders = {
    ...JSON_HEADERS,
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  const walletsResponse = await fetch(
    `${supabaseUrl}/rest/v1/wallets?select=address&active=eq.true`,
    { headers: databaseHeaders }
  );
  if (!walletsResponse.ok) {
    console.error("[helius-webhook] wallet query failed", walletsResponse.status);
    return json({ error: "Database unavailable" }, 500);
  }
  const wallets = (await walletsResponse.json()) as Array<{ address: string }>;
  const activeWallets = new Set(wallets.map((wallet) => wallet.address));

  const maximumAgeMs =
    boundedNumber(Deno.env.get("MAX_TRADE_AGE_SECONDS"), 120, 30, 3_600) *
    1_000;
  const minimumSol = boundedNumber(
    Deno.env.get("MIN_TRACKED_TRADE_SOL"),
    0.01,
    0,
    100
  );
  const scalpMinutes = Math.floor(
    boundedNumber(Deno.env.get("SCALP_WINDOW_MINUTES"), 5, 1, 60)
  );
  const candidates = (payload as EnhancedTransaction[])
    .flatMap((transaction) => extractTrades(transaction, activeWallets))
    .filter((trade) => {
      const ageMs = Date.now() - (trade.txTime as Date).getTime();
      return (
        ageMs >= -30_000 &&
        ageMs <= maximumAgeMs &&
        Number(trade.solAmount) >= minimumSol
      );
    })
    .sort(
      (left, right) =>
        (left.txTime as Date).getTime() - (right.txTime as Date).getTime()
    );

  let storedTrades = 0;
  for (const trade of candidates) {
    const ingestResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/ingest_wallet_trade`,
      {
        method: "POST",
        headers: databaseHeaders,
        body: JSON.stringify({
          p_wallet_address: trade.walletAddress,
          p_signature: trade.signature,
          p_token_mint: trade.tokenMint,
          p_side: trade.side,
          p_sol_amount: trade.solAmount,
          p_token_amount: trade.tokenAmount,
          p_tx_time: (trade.txTime as Date).toISOString(),
          p_scalp_window_minutes: scalpMinutes,
        }),
      }
    );
    if (!ingestResponse.ok) {
      console.error("[helius-webhook] ingest failed", ingestResponse.status);
      return json({ error: "Trade ingest failed" }, 500);
    }
    const result = await ingestResponse.json();
    if (Array.isArray(result) && result[0]?.inserted) storedTrades += 1;
  }

  const usageResponse = await fetch(
    `${supabaseUrl}/rest/v1/rpc/record_helius_webhook_batch`,
    {
      method: "POST",
      headers: databaseHeaders,
      body: JSON.stringify({
        p_events: payload.length,
        p_stored_trades: storedTrades,
      }),
    }
  );
  if (!usageResponse.ok) {
    console.error("[helius-webhook] usage recording failed", usageResponse.status);
  }

  return json({ received: payload.length, storedTrades });
});
