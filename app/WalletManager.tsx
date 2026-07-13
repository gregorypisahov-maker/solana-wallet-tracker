"use client";

import { FormEvent, useState } from "react";

type Wallet = {
  address: string;
  label: string | null;
  active: boolean;
  created_at: string;
  performance: {
    trust_score: number;
    completed_trades: number;
    win_rate: number;
    average_return: number;
  } | null;
};

type Props = {
  onChanged: () => void;
};

export default function WalletManager({ onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const authorization = (value = password) => ({
    Authorization: `Basic ${window.btoa(`owner:${value}`)}`,
  });

  async function readWallets(passwordValue = password) {
    const response = await fetch("/api/wallets", {
      cache: "no-store",
      headers: authorization(passwordValue),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(response.status === 401 ? "Incorrect owner password" : body.error ?? "Could not load wallets");
    }
    setWallets(body.wallets);
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await readWallets(password);
      setMessage("Owner controls unlocked.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not unlock owner controls");
    } finally {
      setBusy(false);
    }
  }

  async function addWallet(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorization() },
        body: JSON.stringify({ address, label }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not add wallet");
      setAddress("");
      setLabel("");
      await readWallets();
      onChanged();
      setMessage("Wallet added and activated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add wallet");
    } finally {
      setBusy(false);
    }
  }

  async function setActive(wallet: Wallet, active: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/wallets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authorization() },
        body: JSON.stringify({ address: wallet.address, active }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not update wallet");
      await readWallets();
      onChanged();
      setMessage(active ? "Wallet reactivated." : "Wallet deactivated. Its history was preserved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update wallet");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ownerArea">
      <button className="ownerToggle" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "Close owner controls" : "Owner controls"}
      </button>

      {open && (
        <div className="ownerPanel">
          <div className="ownerHeading">
            <div>
              <span>PRIVATE ADMINISTRATION</span>
              <h2>Wallet manager</h2>
            </div>
            {wallets && <b>{wallets.filter((wallet) => wallet.active).length}/20 active</b>}
          </div>

          {!wallets ? (
            <form className="ownerLogin" onSubmit={signIn}>
              <label htmlFor="owner-password">Dashboard owner password</label>
              <div>
                <input
                  id="owner-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter owner password"
                  required
                />
                <button type="submit" disabled={busy}>{busy ? "Checking…" : "Unlock"}</button>
              </div>
              <small>The password stays in this browser tab and is never included in the share link.</small>
            </form>
          ) : (
            <>
              <form className="walletAdd" onSubmit={addWallet}>
                <input
                  value={address}
                  onChange={(event) => setAddress(event.target.value.trim())}
                  placeholder="Solana wallet address"
                  spellCheck={false}
                  required
                />
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Label (optional)"
                  maxLength={80}
                />
                <button type="submit" disabled={busy || !address}>{busy ? "Saving…" : "Add wallet"}</button>
              </form>

              <div className="walletRows">
                {wallets.map((wallet) => (
                  <div className={`walletRow ${wallet.active ? "" : "inactive"}`} key={wallet.address}>
                    <div>
                      <strong>{wallet.label || "Unlabelled wallet"}</strong>
                      <code>{wallet.address}</code>
                      <small>
                        {wallet.performance
                          ? `Trust ${Number(wallet.performance.trust_score).toFixed(0)} · ${wallet.performance.completed_trades} trades · ${(Number(wallet.performance.win_rate) * 100).toFixed(0)}% win · ${(Number(wallet.performance.average_return) * 100).toFixed(1)}% avg`
                          : "No matched performance history yet"}
                      </small>
                    </div>
                    <span>{wallet.active ? "ACTIVE" : "INACTIVE"}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setActive(wallet, !wallet.active)}
                    >
                      {wallet.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </div>
                ))}
              </div>
              <p className="ownerNote">Deactivation stops future monitoring but keeps all historical paper-trading data.</p>
            </>
          )}

          {message && <div className="ownerMessage">{message}</div>}
        </div>
      )}
    </section>
  );
}
