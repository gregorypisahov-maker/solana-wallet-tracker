import { getLiveConnection } from "./liveWallet";
import { getSupabaseAdmin } from "./supabase";

export const DEPLOYER_BLACKLIST_VERSION = "deployer_blacklist_v1_2026_08_01";

export type DeployerResolution = { deployer: string | null; method: "helius_getasset" | "mint_creation_signer" | "unresolved" };

function heliusRpcUrl(): string | null {
  const direct = process.env.HELIUS_RPC_URL?.trim();
  if (direct) return direct;
  const key = process.env.HELIUS_API_KEY?.trim();
  return key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : null;
}

function creatorFromAsset(asset: any): string | null {
  const candidates = [
    asset?.creators?.find?.((x: any) => x?.verified)?.address,
    asset?.creators?.[0]?.address,
    asset?.authorities?.[0]?.address,
    asset?.content?.metadata?.creator,
    asset?.content?.metadata?.properties?.creator,
    asset?.token_info?.mint_authority,
  ];
  for (const value of candidates) if (typeof value === "string" && value.length >= 32) return value;
  return null;
}

export async function resolveDeployer(mint: string): Promise<DeployerResolution> {
  const supabase = getSupabaseAdmin();
  const { data: cached, error: cacheError } = await supabase
    .from("deployer_by_mint")
    .select("deployer,method")
    .eq("mint", mint)
    .maybeSingle();
  if (cacheError) throw new Error(`deployer_cache_read_failed:${cacheError.message}`);
  if (cached) return { deployer: cached.deployer ?? null, method: cached.method as DeployerResolution["method"] };

  let result: DeployerResolution = { deployer: null, method: "unresolved" };
  const rpcUrl = heliusRpcUrl();
  if (rpcUrl) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "deployer-getasset", method: "getAsset", params: { id: mint } }),
      });
      if (response.ok) {
        const body = await response.json();
        const deployer = creatorFromAsset(body?.result);
        if (deployer) result = { deployer, method: "helius_getasset" };
      }
    } catch (error) {
      console.warn(`[deployer-blacklist] getAsset failed mint=${mint}`, error);
    }
  }

  if (!result.deployer) {
    try {
      const connection = getLiveConnection();
      let before: string | undefined;
      let oldest: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const signatures = await connection.getSignaturesForAddress(new (await import("@solana/web3.js")).PublicKey(mint), { before, limit: 1000 }, "confirmed");
        if (!signatures.length) break;
        oldest = signatures[signatures.length - 1]?.signature ?? oldest;
        if (signatures.length < 1000) break;
        before = oldest ?? undefined;
      }
      if (oldest) {
        const tx = await connection.getParsedTransaction(oldest, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        const keys = tx?.transaction.message.accountKeys ?? [];
        const signer = keys.find((key: any) => key.signer)?.pubkey?.toBase58?.() ?? null;
        if (signer) result = { deployer: signer, method: "mint_creation_signer" };
      }
    } catch (error) {
      console.warn(`[deployer-blacklist] mint creation fallback failed mint=${mint}`, error);
    }
  }

  const { error: insertError } = await supabase.from("deployer_by_mint").insert({ mint, deployer: result.deployer, method: result.method });
  if (insertError && insertError.code !== "23505") throw new Error(`deployer_cache_write_failed:${insertError.message}`);
  return result;
}

export async function evaluateDeployerReputation(mint: string) {
  const resolution = await resolveDeployer(mint);
  if (!resolution.deployer) return { ...resolution, rugs: 0, tokensSeen: 0 };
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deployer_reputation")
    .select("rugs,tokens_seen")
    .eq("deployer", resolution.deployer)
    .maybeSingle();
  if (error) throw new Error(`deployer_reputation_read_failed:${error.message}`);
  return { ...resolution, rugs: Number(data?.rugs ?? 0), tokensSeen: Number(data?.tokens_seen ?? 0) };
}
