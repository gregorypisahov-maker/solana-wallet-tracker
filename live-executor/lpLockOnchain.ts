import { Connection, PublicKey } from "@solana/web3.js";
import { LP_BURN_ADDRESSES, type LpLockVerdict } from "./lpLockGoplus";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const RAYDIUM_AMM_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzefT4d8xYv7zZAdq1Mp8";

export type OnchainLiquidityStatus =
  | "locked"
  | "burned"
  | "protocol_controlled"
  | "unlocked"
  | "unknown";

export interface OnchainLpResult {
  verdict: LpLockVerdict;
  method: "onchain_authorities" | "onchain_lp_burn" | "onchain_holder_concentration";
  pctLocked: number | null;
  pctBurned: number | null;
  poolAddress: string | null;
  lpMint: string | null;
  status: OnchainLiquidityStatus;
  removablePct: number | null;
  owner: string | null;
  reason: string | null;
  details: Record<string, unknown>;
}

type PoolResolution = {
  protocol: string;
  protocolControlled: boolean;
  lpMint: PublicKey | null;
  vaults: PublicKey[];
  details: Record<string, unknown>;
};

function percentage(amount: bigint, supply: bigint): number {
  if (supply <= 0n || amount <= 0n) return 0;
  return Number((amount * 1_000_000n) / supply) / 10_000;
}

function pubkeyAt(data: Buffer, offset: number): PublicKey | null {
  if (offset < 0 || offset + 32 > data.length) return null;
  try {
    return new PublicKey(data.subarray(offset, offset + 32));
  } catch {
    return null;
  }
}

function configuredLockerPrograms(): Set<string> {
  return new Set(
    String(process.env.LP_KNOWN_LOCKER_PROGRAMS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

async function resolvePool(
  connection: Connection,
  poolAddress: string | null
): Promise<PoolResolution> {
  if (!poolAddress) {
    return { protocol: "missing_pool", protocolControlled: false, lpMint: null, vaults: [], details: {} };
  }

  const pool = new PublicKey(poolAddress);
  const account = await connection.getAccountInfo(pool, "confirmed");
  if (!account) {
    return { protocol: "pool_account_missing", protocolControlled: false, lpMint: null, vaults: [], details: {} };
  }

  const owner = account.owner.toBase58();
  const data = Buffer.from(account.data);
  if (owner === PUMP_PROGRAM) {
    return {
      protocol: "pump_bonding_curve",
      protocolControlled: true,
      lpMint: null,
      vaults: [],
      details: { poolOwnerProgram: owner, poolDataLength: data.length },
    };
  }

  if (owner === PUMP_AMM_PROGRAM) {
    const derivedLpMint = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_lp_mint"), pool.toBuffer()],
      new PublicKey(PUMP_AMM_PROGRAM)
    )[0];
    const decodedLpMint = pubkeyAt(data, 107);
    const baseVault = pubkeyAt(data, 139);
    const quoteVault = pubkeyAt(data, 171);
    const lpMint = decodedLpMint ?? derivedLpMint;
    return {
      protocol: "pump_amm",
      protocolControlled: false,
      lpMint,
      vaults: [baseVault, quoteVault].filter((value): value is PublicKey => value != null),
      details: {
        poolOwnerProgram: owner,
        poolDataLength: data.length,
        derivedLpMint: derivedLpMint.toBase58(),
        decodedLpMint: decodedLpMint?.toBase58() ?? null,
        lpMintDerivationMatched: decodedLpMint ? decodedLpMint.equals(derivedLpMint) : null,
      },
    };
  }

  if (owner === RAYDIUM_AMM_V4_PROGRAM && data.length >= 720) {
    return {
      protocol: "raydium_amm_v4",
      protocolControlled: false,
      lpMint: pubkeyAt(data, 464),
      vaults: [pubkeyAt(data, 336), pubkeyAt(data, 368)].filter(
        (value): value is PublicKey => value != null
      ),
      details: { poolOwnerProgram: owner, poolDataLength: data.length },
    };
  }

  return {
    protocol: "unsupported_pool_program",
    protocolControlled: false,
    lpMint: null,
    vaults: [],
    details: { poolOwnerProgram: owner, poolDataLength: data.length },
  };
}

async function tokenAccountOwners(
  connection: Connection,
  addresses: PublicKey[]
): Promise<Map<string, string | null>> {
  const output = new Map<string, string | null>();
  if (!addresses.length) return output;
  const accounts = await connection.getMultipleParsedAccounts(addresses, "confirmed");
  accounts.value.forEach((account, index) => {
    const info = (account?.data as any)?.parsed?.info;
    output.set(addresses[index].toBase58(), info?.owner ? String(info.owner) : null);
  });
  return output;
}

async function lockerOwnedAmount(
  connection: Connection,
  owners: string[],
  amounts: bigint[]
): Promise<{ amount: bigint; programs: string[] }> {
  const allowlist = configuredLockerPrograms();
  if (!allowlist.size) return { amount: 0n, programs: [] };

  const unique = [...new Set(owners.filter(Boolean))];
  const ownerKeys: PublicKey[] = [];
  for (const owner of unique) {
    try {
      ownerKeys.push(new PublicKey(owner));
    } catch {
      // Ignore malformed owner values returned by an RPC provider.
    }
  }
  const accounts = ownerKeys.length
    ? await connection.getMultipleAccountsInfo(ownerKeys, "confirmed")
    : [];
  const lockerOwners = new Map<string, string>();
  accounts.forEach((account, index) => {
    const program = account?.owner.toBase58();
    if (program && allowlist.has(program)) lockerOwners.set(ownerKeys[index].toBase58(), program);
  });

  let amount = 0n;
  const programs = new Set<string>();
  owners.forEach((owner, index) => {
    const program = lockerOwners.get(owner);
    if (!program) return;
    amount += amounts[index] ?? 0n;
    programs.add(program);
  });
  return { amount, programs: [...programs] };
}

export async function evaluateOnchainLiquiditySafety(input: {
  connection: Connection;
  mint: string;
  poolAddress?: string | null;
  lockMinPct?: number;
  maxTopHolderPct?: number;
}): Promise<OnchainLpResult> {
  const lockMinPct = input.lockMinPct ?? 95;
  const maxTopHolderPct = input.maxTopHolderPct ?? 30;
  const mint = new PublicKey(input.mint);
  const poolAddress = input.poolAddress ?? null;
  const parsedMint = await input.connection.getParsedAccountInfo(mint, "confirmed");
  const mintInfo = (parsedMint.value?.data as any)?.parsed?.info;
  if (!mintInfo) {
    return {
      verdict: "UNKNOWN",
      method: "onchain_authorities",
      pctLocked: null,
      pctBurned: null,
      poolAddress,
      lpMint: null,
      status: "unknown",
      removablePct: null,
      owner: null,
      reason: "mint_account_unreadable",
      details: {},
    };
  }

  const mintAuthority = mintInfo.mintAuthority ?? null;
  const freezeAuthority = mintInfo.freezeAuthority ?? null;
  const authorityDetails = {
    mintAuthority,
    freezeAuthority,
    authoritiesRenounced: mintAuthority == null && freezeAuthority == null,
  };
  if (mintAuthority || freezeAuthority) {
    return {
      verdict: "UNLOCKED",
      method: "onchain_authorities",
      pctLocked: null,
      pctBurned: null,
      poolAddress,
      lpMint: null,
      status: "unlocked",
      removablePct: 100,
      owner: String(mintAuthority ?? freezeAuthority),
      reason: mintAuthority ? "mint_authority_active" : "freeze_authority_active",
      details: authorityDetails,
    };
  }

  const pool = await resolvePool(input.connection, poolAddress);
  if (pool.protocolControlled) {
    return {
      verdict: "LOCKED",
      method: "onchain_lp_burn",
      pctLocked: 100,
      pctBurned: 0,
      poolAddress,
      lpMint: null,
      status: "protocol_controlled",
      removablePct: 0,
      owner: typeof pool.details.poolOwnerProgram === "string" ? pool.details.poolOwnerProgram : null,
      reason: null,
      details: { ...authorityDetails, ...pool.details, protocol: pool.protocol },
    };
  }

  if (pool.lpMint) {
    const supplyResponse = await input.connection.getTokenSupply(pool.lpMint, "confirmed");
    const supply = BigInt(supplyResponse.value.amount);
    const largest = await input.connection.getTokenLargestAccounts(pool.lpMint, "confirmed");
    const addresses = largest.value.map((item) => item.address);
    const amounts = largest.value.map((item) => BigInt(item.amount));
    const ownersByAccount = await tokenAccountOwners(input.connection, addresses);
    const owners = addresses.map((address) => ownersByAccount.get(address.toBase58()) ?? "");

    let burnedAmount = 0n;
    owners.forEach((owner, index) => {
      const tokenAccount = addresses[index].toBase58();
      if (LP_BURN_ADDRESSES.has(owner) || LP_BURN_ADDRESSES.has(tokenAccount)) {
        burnedAmount += amounts[index] ?? 0n;
      }
    });
    const locker = await lockerOwnedAmount(input.connection, owners, amounts);
    const pctBurned = percentage(burnedAmount, supply);
    const pctLocker = percentage(locker.amount, supply);
    const pctLocked = Math.min(100, pctBurned + pctLocker);
    const removablePct = Math.max(0, 100 - pctLocked);
    const details = {
      ...authorityDetails,
      ...pool.details,
      protocol: pool.protocol,
      lpMint: pool.lpMint.toBase58(),
      lpSupply: supply.toString(),
      largestLpAccountsSampled: addresses.length,
      pctLocker,
      lockerPrograms: locker.programs,
    };

    return pctLocked >= lockMinPct
      ? {
          verdict: "LOCKED",
          method: "onchain_lp_burn",
          pctLocked,
          pctBurned,
          poolAddress,
          lpMint: pool.lpMint.toBase58(),
          status: pctBurned >= lockMinPct ? "burned" : "locked",
          removablePct,
          owner: null,
          reason: null,
          details,
        }
      : {
          verdict: "UNLOCKED",
          method: "onchain_lp_burn",
          pctLocked,
          pctBurned,
          poolAddress,
          lpMint: pool.lpMint.toBase58(),
          status: "unlocked",
          removablePct,
          owner: owners[0] || null,
          reason: "insufficient_liquidity_locked",
          details,
        };
  }

  const supply = BigInt(String(mintInfo.supply ?? "0"));
  const largest = await input.connection.getTokenLargestAccounts(mint, "confirmed");
  const addresses = largest.value.slice(0, 10).map((item) => item.address);
  const amounts = largest.value.slice(0, 10).map((item) => BigInt(item.amount));
  const ownersByAccount = await tokenAccountOwners(input.connection, addresses);
  const vaults = new Set(pool.vaults.map((vault) => vault.toBase58()));
  let topNonPoolAmount = 0n;
  let topNonPoolOwner: string | null = null;
  for (let index = 0; index < addresses.length; index += 1) {
    const account = addresses[index].toBase58();
    const owner = ownersByAccount.get(account) ?? null;
    if (vaults.has(account) || LP_BURN_ADDRESSES.has(account) || (owner && LP_BURN_ADDRESSES.has(owner))) {
      continue;
    }
    topNonPoolAmount = amounts[index] ?? 0n;
    topNonPoolOwner = owner;
    break;
  }
  const topHolderPct = percentage(topNonPoolAmount, supply);
  const details = {
    ...authorityDetails,
    ...pool.details,
    protocol: pool.protocol,
    topNonPoolHolderPct: topHolderPct,
    topNonPoolHolderOwner: topNonPoolOwner,
    concentrationThresholdPct: maxTopHolderPct,
    excludedPoolVaults: [...vaults],
  };

  if (topHolderPct > maxTopHolderPct) {
    return {
      verdict: "UNLOCKED",
      method: "onchain_holder_concentration",
      pctLocked: null,
      pctBurned: null,
      poolAddress,
      lpMint: null,
      status: "unlocked",
      removablePct: null,
      owner: topNonPoolOwner,
      reason: "top_holder_concentration",
      details,
    };
  }

  return {
    verdict: "UNKNOWN",
    method: "onchain_holder_concentration",
    pctLocked: null,
    pctBurned: null,
    poolAddress,
    lpMint: null,
    status: "unknown",
    removablePct: null,
    owner: topNonPoolOwner,
    reason: "lp_mint_unresolved",
    details,
  };
}
