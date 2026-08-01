import type { PublicKey } from "@solana/web3.js";

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
      getAccountKeys(input?: unknown): {
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
    loadedAddresses?: unknown;
  } | null;
};

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
