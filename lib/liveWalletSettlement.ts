import type { PublicKey } from "@solana/web3.js";
import {
  executeJupiterSwap,
  getLiveConnection,
  getLiveSigner,
} from "./liveWallet";

export type WalletSettlementDeltas = {
  solLamportsDelta: bigint;
  tokenRawDelta: bigint;
};

type TokenBalance = {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};

type SettlementTransaction = {
  transaction: {
    message: {
      getAccountKeys(input?: any): {
        length: number;
        get(index: number): PublicKey | undefined;
      };
    };
  };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: any;
  } | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tokenTotal(
  balances: TokenBalance[] | null | undefined,
  owner: string,
  mint: string
): bigint {
  return (balances ?? []).reduce((total, balance) => {
    if (balance.owner !== owner || balance.mint !== mint) return total;
    const raw = balance.uiTokenAmount?.amount;
    return total + (typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : 0n);
  }, 0n);
}

export function walletSettlementFromTransaction(
  transaction: SettlementTransaction,
  owner: PublicKey,
  tokenMint: string
): WalletSettlementDeltas {
  if (!transaction.meta) throw new Error("Confirmed transaction has no metadata");
  if (transaction.meta.err) {
    throw new Error(`Confirmed transaction failed: ${JSON.stringify(transaction.meta.err)}`);
  }

  const keys = transaction.transaction.message.getAccountKeys({
    accountKeysFromLookups: transaction.meta.loadedAddresses,
  });
  const ownerText = owner.toBase58();
  let ownerIndex = -1;
  for (let index = 0; index < keys.length; index += 1) {
    if (keys.get(index)?.toBase58() === ownerText) {
      ownerIndex = index;
      break;
    }
  }
  if (ownerIndex < 0) throw new Error("Signer account is missing from confirmed transaction");

  const preLamports = transaction.meta.preBalances[ownerIndex];
  const postLamports = transaction.meta.postBalances[ownerIndex];
  if (!Number.isSafeInteger(preLamports) || !Number.isSafeInteger(postLamports)) {
    throw new Error("Confirmed transaction has invalid signer balances");
  }

  const preToken = tokenTotal(transaction.meta.preTokenBalances, ownerText, tokenMint);
  const postToken = tokenTotal(transaction.meta.postTokenBalances, ownerText, tokenMint);
  return {
    solLamportsDelta: BigInt(postLamports) - BigInt(preLamports),
    tokenRawDelta: postToken - preToken,
  };
}

export async function getConfirmedWalletSettlement(
  signature: string,
  tokenMint: string
): Promise<WalletSettlementDeltas> {
  const connection = getLiveConnection();
  const owner = getLiveSigner().publicKey;
  let lastError = "Confirmed transaction metadata is unavailable";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const transaction = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (transaction) return walletSettlementFromTransaction(transaction, owner, tokenMint);
      lastError = "Confirmed transaction metadata is not indexed yet";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 8) await sleep(500 * attempt);
  }
  throw new Error(`${lastError}: ${signature}`);
}

export async function executeJupiterSwapWithSettlement(input: {
  inputMint: string;
  outputMint: string;
  rawAmount: string;
  slippageBps: number;
  settlementTokenMint: string;
}) {
  const result = await executeJupiterSwap(input);
  try {
    const settlement = await getConfirmedWalletSettlement(
      result.signature,
      input.settlementTokenMint
    );
    return { ...result, settlement };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Swap confirmed but settlement could not be reconciled: ${message}`);
  }
}
