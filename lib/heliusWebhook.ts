import { createHash, timingSafeEqual } from "node:crypto";
import type { DetectedTrade } from "./solana";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

interface EnhancedTokenBalanceChange {
  mint?: string;
  userAccount?: string;
  rawTokenAmount?: {
    decimals?: number;
    tokenAmount?: string;
  };
}

interface EnhancedAccountData {
  account?: string;
  nativeBalanceChange?: number;
  tokenBalanceChanges?: EnhancedTokenBalanceChange[];
}

export interface HeliusEnhancedTransaction {
  type?: string;
  signature?: string;
  timestamp?: number;
  fee?: number;
  accountData?: EnhancedAccountData[];
}

function safeTokenDelta(change: EnhancedTokenBalanceChange): number {
  const raw = Number(change.rawTokenAmount?.tokenAmount ?? 0);
  const decimals = Number(change.rawTokenAmount?.decimals ?? 0);
  if (!Number.isFinite(raw) || !Number.isFinite(decimals)) return 0;
  return raw / 10 ** Math.max(0, decimals);
}

/**
 * Turn Helius' filtered SWAP payload into the same wallet-relative trade shape
 * used by the RPC fallback. This remains DEX-agnostic: it only examines the
 * tracked wallet's native and token balance changes.
 */
export function extractTradesFromEnhancedTransaction(
  transaction: HeliusEnhancedTransaction,
  trackedWallets: ReadonlySet<string>
): Array<{ walletAddress: string; trade: DetectedTrade }> {
  if (
    transaction.type !== "SWAP" ||
    !transaction.signature ||
    !Number.isFinite(transaction.timestamp)
  ) {
    return [];
  }

  const accountData = transaction.accountData ?? [];
  const feeSol = Math.max(0, Number(transaction.fee ?? 0)) / 1e9;
  const trades: Array<{ walletAddress: string; trade: DetectedTrade }> = [];

  for (const walletAddress of trackedWallets) {
    const nativeDelta =
      accountData
        .filter((row) => row.account === walletAddress)
        .reduce((sum, row) => sum + Number(row.nativeBalanceChange ?? 0), 0) /
      1e9;

    const tokenDeltas = new Map<string, number>();
    for (const row of accountData) {
      for (const change of row.tokenBalanceChanges ?? []) {
        if (
          change.userAccount !== walletAddress ||
          !change.mint ||
          change.mint === WSOL_MINT
        ) {
          continue;
        }
        tokenDeltas.set(
          change.mint,
          (tokenDeltas.get(change.mint) ?? 0) + safeTokenDelta(change)
        );
      }
    }

    let tokenMint: string | null = null;
    let tokenDelta = 0;
    for (const [mint, delta] of tokenDeltas) {
      if (Math.abs(delta) > Math.abs(tokenDelta)) {
        tokenMint = mint;
        tokenDelta = delta;
      }
    }

    if (!tokenMint || tokenDelta === 0) continue;

    const common = {
      signature: transaction.signature,
      tokenMint,
      txTime: new Date(Number(transaction.timestamp) * 1_000),
    };

    if (tokenDelta > 0 && nativeDelta < -feeSol) {
      trades.push({
        walletAddress,
        trade: {
          ...common,
          side: "buy",
          solAmount: Math.abs(nativeDelta),
          tokenAmount: tokenDelta,
        },
      });
    } else if (tokenDelta < 0 && nativeDelta > 0) {
      trades.push({
        walletAddress,
        trade: {
          ...common,
          side: "sell",
          solAmount: nativeDelta,
          tokenAmount: Math.abs(tokenDelta),
        },
      });
    }
  }

  return trades;
}

export function deriveHeliusWebhookToken(serviceRoleKey: string): string {
  return createHash("sha256")
    .update(`solana-wallet-tracker:helius-webhook:${serviceRoleKey}`)
    .digest("hex");
}

export function isValidHeliusWebhookAuthorization(
  authorization: string | null,
  serviceRoleKey: string
): boolean {
  const expected = Buffer.from(
    `Bearer ${deriveHeliusWebhookToken(serviceRoleKey)}`,
    "utf8"
  );
  const actual = Buffer.from(authorization ?? "", "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function extractHeliusApiKey(rpcUrl: string): string | null {
  try {
    return new URL(rpcUrl).searchParams.get("api-key");
  } catch {
    return null;
  }
}
