"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import styles from "./sol-spot-live-wallet.module.css";

type WalletPublicKey = { toString(): string };
type InjectedWallet = {
  publicKey?: WalletPublicKey | null;
  isConnected?: boolean;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: WalletPublicKey }>;
  disconnect?(): Promise<void>;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
};

type LiveData = {
  generatedAt: string;
  settings: {
    wallet_public_key: string | null;
    armed: boolean;
    armed_until: string | null;
    max_position_usdt: number | string;
    max_price_impact_pct: number | string;
  };
  livePosition: any | null;
  paperPosition: any | null;
  nextAction: "buy" | "sell" | "hold" | "none";
  trades: any[];
  orders: any[];
  realizedPnlUsdt: number;
  execution: {
    custody: string;
    mode: string;
    venue: string;
    apiAccess: string;
  };
};

declare global {
  interface Window {
    phantom?: { solana?: InjectedWallet };
    solflare?: InjectedWallet;
    backpack?: { solana?: InjectedWallet };
  }
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const short = (value: string | null | undefined) =>
  value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "Not linked";
const israelTime = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: "Asia/Jerusalem",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
};

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value[index]);
  return btoa(binary);
}

function detectedWallet(): { name: string; provider: InjectedWallet } | null {
  if (typeof window === "undefined") return null;
  if (window.phantom?.solana) return { name: "Phantom", provider: window.phantom.solana };
  if (window.solflare) return { name: "Solflare", provider: window.solflare };
  if (window.backpack?.solana) return { name: "Backpack", provider: window.backpack.solana };
  return null;
}

export default function SolSpotLiveWallet() {
  const [data, setData] = useState<LiveData | null>(null);
  const [provider, setProvider] = useState<InjectedWallet | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [size, setSize] = useState("25");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [explorerUrl, setExplorerUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/sol-spot-live", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load real-wallet state");
      const body = (await response.json()) as LiveData;
      setData(body);
      setSize(String(num(body.settings.max_position_usdt) || 25));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load real-wallet state");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const linkedMatches = Boolean(
    data?.settings.wallet_public_key &&
      connectedAddress &&
      data.settings.wallet_public_key === connectedAddress
  );

  const nextLabel = useMemo(() => {
    if (!data) return "Loading";
    if (data.nextAction === "buy") return "Paper entry open · real BUY can be approved";
    if (data.nextAction === "sell") return "Paper position closed · real SELL approval needed";
    if (data.nextAction === "hold") return "Real position open · following the paper position";
    return "Waiting for the next paper entry";
  }, [data]);

  const getOwnerPassword = () => {
    const value = ownerPassword.trim();
    if (!value) throw new Error("Enter the dashboard owner password above");
    return value;
  };

  const adminPost = async (path: string, payload: Record<string, unknown>) => {
    const password = getOwnerPassword();
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`owner:${password}`)}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) setOwnerPassword("");
      throw new Error(body.error ?? "Owner action failed");
    }
    return body;
  };

  const connect = async () => {
    setBusy("connect");
    setError(null);
    setNotice(null);
    try {
      const found = detectedWallet();
      if (!found) {
        throw new Error(
          "No Solana wallet was detected. On iPhone, open this dashboard inside Phantom or Solflare's in-app browser."
        );
      }
      const connected = await found.provider.connect();
      const address = connected.publicKey?.toString() ?? found.provider.publicKey?.toString();
      if (!address) throw new Error("The wallet connected without returning an address");
      setProvider(found.provider);
      setWalletName(found.name);
      setConnectedAddress(address);
      setNotice(`${found.name} connected. No private key was shared.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection failed");
    } finally {
      setBusy(null);
    }
  };

  const linkWallet = async () => {
    if (!connectedAddress) return;
    setBusy("link");
    setError(null);
    try {
      await adminPost("/api/sol-spot-live", {
        action: "link_wallet",
        walletPublicKey: connectedAddress,
      });
      setNotice("Wallet linked. Real execution remains disarmed.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not link wallet");
    } finally {
      setBusy(null);
    }
  };

  const setArmed = async (armed: boolean) => {
    setBusy(armed ? "arm" : "disarm");
    setError(null);
    try {
      await adminPost("/api/sol-spot-live", {
        action: armed ? "arm" : "disarm",
        walletPublicKey: connectedAddress,
      });
      setNotice(armed ? "Real mirror armed for six hours. Every swap still needs wallet approval." : "Real execution disarmed.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change live mode");
    } finally {
      setBusy(null);
    }
  };

  const saveSize = async () => {
    setBusy("size");
    setError(null);
    try {
      await adminPost("/api/sol-spot-live", {
        action: "set_size",
        maxPositionUsdt: Number(size),
      });
      setNotice("Real position cap saved. Live execution was disarmed for safety.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save real size");
    } finally {
      setBusy(null);
    }
  };

  const approve = async (side: "buy" | "sell") => {
    if (!provider || !connectedAddress || !linkedMatches) {
      setError("Connect the linked wallet first");
      return;
    }
    setBusy(side);
    setError(null);
    setNotice(null);
    setExplorerUrl(null);
    try {
      const prepared = await adminPost("/api/sol-spot-live/order", {
        side,
        walletPublicKey: connectedAddress,
      });
      const transaction = VersionedTransaction.deserialize(decodeBase64(prepared.transaction));
      const signed = await provider.signTransaction(transaction);
      const response = await fetch("/api/sol-spot-live/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: prepared.orderId,
          requestId: prepared.requestId,
          signedTransaction: encodeBase64(signed.serialize()),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Real swap failed");
      setNotice(`Real ${side.toUpperCase()} confirmed on Solana.`);
      setExplorerUrl(result.explorerUrl ?? null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet approval failed");
    } finally {
      setBusy(null);
    }
  };

  const settings = data?.settings;
  const livePosition = data?.livePosition;

  return (
    <article className={styles.panel}>
      <div className={styles.head}>
        <div>
          <span className={styles.eyebrow}>OPTIONAL REAL EXECUTION · SOLANA MAINNET</span>
          <h3>Connect wallet and approve real SOL/USDT trades</h3>
          <p>The strategy creates the signal; Phantom, Solflare or Backpack must sign every Jupiter swap.</p>
        </div>
        <span className={`${styles.mode} ${settings?.armed ? styles.armed : ""}`}>
          {settings?.armed ? "ARMED" : "DISARMED"}
        </span>
      </div>

      <div className={styles.safety}>
        <b>No seed phrase or private key is stored.</b> This is manual approval, not unattended trading. A browser wallet cannot execute a stop while the dashboard is closed.
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {notice && <div className={styles.notice}>{notice}{explorerUrl && <> · <a href={explorerUrl} target="_blank" rel="noreferrer">View transaction</a></>}</div>}

      <div className={styles.grid}>
        <div className={styles.metric}><span>Connected wallet</span><strong>{connectedAddress ? short(connectedAddress) : "Not connected"}</strong><small>{walletName ?? "Open inside a Solana wallet browser on iPhone"}</small></div>
        <div className={styles.metric}><span>Linked wallet</span><strong>{short(settings?.wallet_public_key)}</strong><small>{linkedMatches ? "Connected address matches" : "Connect the linked address"}</small></div>
        <div className={styles.metric}><span>Arm expiry</span><strong>{settings?.armed ? israelTime(settings.armed_until) : "Disarmed"}</strong><small>Automatically expires after six hours</small></div>
        <div className={styles.metric}><span>Next action</span><strong>{data?.nextAction?.toUpperCase() ?? "—"}</strong><small>{nextLabel}</small></div>
      </div>

      <div className={styles.passwordRow}>
        <label htmlFor="sol-live-owner-password">
          Dashboard owner password
          <input
            id="sol-live-owner-password"
            type="password"
            value={ownerPassword}
            onChange={(event) => setOwnerPassword(event.target.value)}
            placeholder="Enter owner password"
            autoComplete="current-password"
          />
        </label>
        <small>Use the dashboard owner/admin password—not your Solflare password, PIN, seed phrase or private key.</small>
      </div>

      <div className={styles.controls}>
        <button onClick={connect} disabled={Boolean(busy)}>{busy === "connect" ? "Connecting…" : connectedAddress ? "Reconnect wallet" : "Connect wallet"}</button>
        <button onClick={linkWallet} disabled={!connectedAddress || Boolean(busy) || linkedMatches}>{busy === "link" ? "Linking…" : linkedMatches ? "Wallet linked" : "Link this wallet"}</button>
        {settings?.armed ? (
          <button className={styles.danger} onClick={() => void setArmed(false)} disabled={Boolean(busy)}>Disarm</button>
        ) : (
          <button className={styles.arm} onClick={() => void setArmed(true)} disabled={!linkedMatches || Boolean(busy)}>Arm for 6 hours</button>
        )}
      </div>

      <div className={styles.sizeRow}>
        <label>
          Maximum real buy
          <span><input type="number" min="10" max="200" step="5" value={size} onChange={(event) => setSize(event.target.value)} /> USDT</span>
        </label>
        <button onClick={saveSize} disabled={Boolean(busy)}>{busy === "size" ? "Saving…" : "Save size"}</button>
        <small>Changing size automatically disarms the bot.</small>
      </div>

      <div className={styles.tradeActions}>
        <button
          className={styles.buy}
          onClick={() => void approve("buy")}
          disabled={!linkedMatches || !settings?.armed || data?.nextAction !== "buy" || Boolean(busy)}
        >
          {busy === "buy" ? "Waiting for wallet…" : `Approve real BUY · ${num(settings?.max_position_usdt).toFixed(0)} USDT`}
        </button>
        <button
          className={styles.sell}
          onClick={() => void approve("sell")}
          disabled={!linkedMatches || !livePosition || Boolean(busy)}
        >
          {busy === "sell" ? "Waiting for wallet…" : "Sell tracked SOL now"}
        </button>
      </div>

      {livePosition && (
        <div className={styles.position}>
          <div><span>Tracked real position</span><strong>{num(livePosition.quantity_sol).toFixed(6)} SOL</strong></div>
          <div><span>Actual cost</span><strong>{num(livePosition.cost_usdt).toFixed(2)} USDT</strong></div>
          <div><span>Opened</span><strong>{israelTime(livePosition.opened_at)}</strong></div>
          <div><span>Entry signature</span><strong>{short(livePosition.entry_signature)}</strong></div>
        </div>
      )}

      <div className={styles.footer}>
        <span>Venue: Jupiter on Solana · official USDT mint</span>
        <span>Realized live PnL: <b>{num(data?.realizedPnlUsdt).toFixed(2)} USDT</b></span>
      </div>
    </article>
  );
}
