import { Connection, PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from "@solana/web3.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function getConnection() {
  const url = process.env.SOLANA_RPC_URL?.trim() || process.env.ALCHEMY_RPC_URL?.trim() || process.env.HELIUS_RPC_URL?.trim();
  if (!url) {
    throw new Error(
      "Missing Solana RPC URL. Set SOLANA_RPC_URL (preferred), ALCHEMY_RPC_URL, or HELIUS_RPC_URL."
    );
  }

  const wsEndpoint =
    process.env.SOLANA_WS_URL?.trim() ||
    process.env.ALCHEMY_WS_URL?.trim() ||
    undefined;

  return new Connection(url, {
    commitment: "confirmed",
    ...(wsEndpoint ? { wsEndpoint } : {}),
    // @solana/web3.js otherwise retries 429 responses every 500ms internally,
    // which creates a retry storm. The monitor owns exponential backoff and
    // global request pacing instead.
    disableRetryOnRateLimit: true,
  });
}

export interface DetectedTrade {
  signature: string;
  tokenMint: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  txTime: Date;
}

/**
 * Fetch signatures for a wallet newer than `untilSignature` (if provided).
 * Returns oldest-first so we process trades in chronological order.
 */
export async function fetchNewSignatures(
  connection: Connection,
  address: string,
  untilSignature: string | null,
  maxSignatures = 50,
  onRequest: () => void = () => undefined
) {
  const pubkey = new PublicKey(address);
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;

  while (sigs.length < maxSignatures) {
    const pageSize = Math.min(100, maxSignatures - sigs.length);
    onRequest();
    const page = await connection.getSignaturesForAddress(
      pubkey,
      { limit: pageSize, before, until: untilSignature ?? undefined },
      "confirmed"
    );
    sigs.push(...page);
    if (page.length < pageSize) break;
    before = page[page.length - 1]?.signature;
    if (!before) break;
  }
  // getSignaturesForAddress returns newest-first; reverse for chronological processing
  return sigs.filter((s) => !s.err).reverse();
}

/**
 * Given a parsed transaction, work out whether the tracked wallet bought or sold
 * an SPL token, using pre/post SOL and token balance deltas. This approach is
 * DEX-agnostic (works for Raydium, Pump.fun, Jupiter, Meteora, etc.) because it
 * doesn't try to decode program-specific instructions — it just looks at what
 * changed in the wallet's own balances.
 */
export function extractTrade(
  tx: ParsedTransactionWithMeta,
  walletAddress: string
): DetectedTrade | null {
  if (!tx.meta || !tx.blockTime) return null;

  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const walletIndex = accountKeys.indexOf(walletAddress);
  if (walletIndex === -1) return null;

  const preSol = tx.meta.preBalances[walletIndex] ?? 0;
  const postSol = tx.meta.postBalances[walletIndex] ?? 0;
  const solDeltaLamports = postSol - preSol;
  const solDelta = solDeltaLamports / 1e9;

  const preTokenBalances = (tx.meta.preTokenBalances ?? []).filter(
    (b) => b.owner === walletAddress && b.mint !== WSOL_MINT
  );
  const postTokenBalances = (tx.meta.postTokenBalances ?? []).filter(
    (b) => b.owner === walletAddress && b.mint !== WSOL_MINT
  );

  // Merge pre/post by mint to compute per-token deltas
  const mints = new Set([
    ...preTokenBalances.map((b) => b.mint),
    ...postTokenBalances.map((b) => b.mint),
  ]);

  let biggestMint: string | null = null;
  let biggestDelta = 0;

  for (const mint of mints) {
    const pre = preTokenBalances.find((b) => b.mint === mint);
    const post = postTokenBalances.find((b) => b.mint === mint);
    const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount ?? 0) : 0;
    const postAmt = post ? Number(post.uiTokenAmount.uiAmount ?? 0) : 0;
    const delta = postAmt - preAmt;
    if (Math.abs(delta) > Math.abs(biggestDelta)) {
      biggestDelta = delta;
      biggestMint = mint;
    }
  }

  if (!biggestMint || biggestDelta === 0) return null;

  // fee is tiny (~0.000005-0.001 SOL) so a real swap will dominate that noise
  const feeSol = tx.meta.fee / 1e9;

  if (biggestDelta > 0 && solDelta < -feeSol) {
    // token balance went up, SOL went down => BUY
    return {
      signature: tx.transaction.signatures[0],
      tokenMint: biggestMint,
      side: "buy",
      solAmount: Math.abs(solDelta),
      tokenAmount: biggestDelta,
      txTime: new Date(tx.blockTime * 1000),
    };
  }

  if (biggestDelta < 0 && solDelta > 0) {
    // token balance went down, SOL went up => SELL
    return {
      signature: tx.transaction.signatures[0],
      tokenMint: biggestMint,
      side: "sell",
      solAmount: Math.abs(solDelta),
      tokenAmount: Math.abs(biggestDelta),
      txTime: new Date(tx.blockTime * 1000),
    };
  }

  return null;
}

export async function getParsedTx(connection: Connection, signature: string) {
  return connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
}
