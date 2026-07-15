import {
  deriveHeliusWebhookToken,
  extractHeliusApiKey,
} from "../lib/heliusWebhook";

interface HeliusWebhookRecord {
  webhookID?: string;
  webhookURL?: string;
  webhookType?: string;
  transactionTypes?: string[];
  accountAddresses?: string[];
}

export interface EnsureHeliusWebhookResult {
  active: boolean;
  action: "existing" | "created" | "updated" | "conflict" | "failed";
  webhookId?: string;
  message?: string;
}

function sameStrings(left: string[] = [], right: string[] = []): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

export async function ensureHeliusSwapWebhook(options: {
  rpcUrl: string;
  serviceRoleKey: string;
  webhookUrl: string;
  accountAddresses: string[];
  fetchImpl?: typeof fetch;
}): Promise<EnsureHeliusWebhookResult> {
  const apiKey = extractHeliusApiKey(options.rpcUrl);
  if (!apiKey) {
    return { active: false, action: "failed", message: "missing Helius API key" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL("https://mainnet.helius-rpc.com/v0/webhooks");
  endpoint.searchParams.set("api-key", apiKey);
  const headers = { "Content-Type": "application/json" };

  try {
    const listResponse = await fetchImpl(endpoint, { method: "GET" });
    if (!listResponse.ok) {
      return {
        active: false,
        action: "failed",
        message: `list failed (${listResponse.status})`,
      };
    }

    const records = (await listResponse.json()) as HeliusWebhookRecord[];
    const existing = records.find(
      (record) => record.webhookURL === options.webhookUrl
    );
    const desiredAddresses = [...new Set(options.accountAddresses)].sort();
    const body = {
      webhookURL: options.webhookUrl,
      webhookType: "enhanced",
      transactionTypes: ["SWAP"],
      accountAddresses: desiredAddresses,
      authHeader: `Bearer ${deriveHeliusWebhookToken(options.serviceRoleKey)}`,
      txnStatus: "success",
    };

    if (existing?.webhookID) {
      const alreadyMatches =
        existing.webhookType === "enhanced" &&
        sameStrings(existing.transactionTypes, ["SWAP"]) &&
        sameStrings(existing.accountAddresses, desiredAddresses);
      if (alreadyMatches) {
        return {
          active: true,
          action: "existing",
          webhookId: existing.webhookID,
        };
      }

      const updateUrl = new URL(
        `https://mainnet.helius-rpc.com/v0/webhooks/${existing.webhookID}`
      );
      updateUrl.searchParams.set("api-key", apiKey);
      const updateResponse = await fetchImpl(updateUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      if (!updateResponse.ok) {
        return {
          active: false,
          action: "failed",
          message: `update failed (${updateResponse.status})`,
        };
      }
      return {
        active: true,
        action: "updated",
        webhookId: existing.webhookID,
      };
    }

    if (records.length > 0) {
      return {
        active: false,
        action: "conflict",
        message: "the Free-plan webhook slot is already used by another URL",
      };
    }

    const createResponse = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!createResponse.ok) {
      return {
        active: false,
        action: "failed",
        message: `create failed (${createResponse.status})`,
      };
    }
    const created = (await createResponse.json()) as HeliusWebhookRecord;
    return {
      active: true,
      action: "created",
      webhookId: created.webhookID,
    };
  } catch (error) {
    return {
      active: false,
      action: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
