"use client";

import { FormEvent, useState } from "react";

type Wallet = {
  address: string;
  label: string | null;
  active: boolean;
  created_at: string;
  performance: { trust_score: number; completed_trades: number; win_rate: number; average_return: number } | null;
};

type Props = { onChanged: () => void };

export default function WalletManager({ onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const authorization = (value = password) => ({ Authorization: `Basic ${window.btoa(`owner:${value}`)}` });

  async function readWallets(passwordValue = password) {
    const response = await fetch("/api/wallets", { cache: "no-store", headers: authorization(passwordValue) });
    const body = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "Incorrect owner password" : body.error ?? "Could not load wallets");
    setWallets(body.wallets);
  }

  async function finishChange(successMessage: string) {
    await readWallets();
    onChanged();
    setMessage(successMessage);
  }

  async function signIn(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try { await readWallets(password); setMessage("Owner controls unlocked."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not unlock owner controls"); }
    finally { setBusy(false); }
  }

  async function addWallet(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/wallets", { method: "POST", headers: { "Content-Type": "application/json", ...authorization() }, body: JSON.stringify({ address, label }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not add wallet");
      setAddress(""); setLabel("");
      await finishChange("Wallet added and activated.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not add wallet"); }
    finally { setBusy(false); }
  }

  async function patchWallet(wallet: Wallet, changes: { active?: boolean; label?: string }) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/wallets", { method: "PATCH", headers: { "Content-Type": "application/json", ...authorization() }, body: JSON.stringify({ address: wallet.address, ...changes }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not update wallet");
      setEditingAddress(null);
      await finishChange(changes.label !== undefined ? "Wallet renamed." : changes.active ? "Wallet reactivated." : "Wallet deactivated.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not update wallet"); }
    finally { setBusy(false); }
  }

  async function removeWallet(wallet: Wallet) {
    if (!window.confirm(`Remove ${wallet.label || wallet.address} from the command center? Historical trades remain in the trading tables.`)) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/wallets", { method: "DELETE", headers: { "Content-Type": "application/json", ...authorization() }, body: JSON.stringify({ address: wallet.address }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not remove wallet");
      await finishChange("Wallet removed from the command center.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not remove wallet"); }
    finally { setBusy(false); }
  }

  return (
    <section className="ownerArea">
      <button className="ownerToggle" type="button" onClick={() => setOpen((value) => !value)}>{open ? "Close owner controls" : "Owner controls"}</button>
      {open && <div className="ownerPanel">
        <div className="ownerHeading"><div><span>PRIVATE ADMINISTRATION</span><h2>Wallet manager</h2></div>{wallets && <b>{wallets.filter((wallet) => wallet.active).length}/20 active</b>}</div>
        {!wallets ? (
          <form className="ownerLogin" onSubmit={signIn}>
            <label htmlFor="owner-password">Dashboard owner password</label>
            <div><input id="owner-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter owner password" required /><button type="submit" disabled={busy}>{busy ? "Checking…" : "Unlock"}</button></div>
            <small>The password stays in this browser tab and is never included in the share link.</small>
          </form>
        ) : <>
          <form className="walletAdd" onSubmit={addWallet}>
            <input value={address} onChange={(event) => setAddress(event.target.value.trim())} placeholder="Solana wallet address" spellCheck={false} required />
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Name / label (optional)" maxLength={80} />
            <button type="submit" disabled={busy || !address}>{busy ? "Saving…" : "Add wallet"}</button>
          </form>
          <div className="walletRows">{wallets.map((wallet) => (
            <div className={`walletRow ${wallet.active ? "" : "inactive"}`} key={wallet.address}>
              <div>
                {editingAddress === wallet.address ? <input value={editingLabel} onChange={(event) => setEditingLabel(event.target.value)} maxLength={80} autoFocus /> : <strong>{wallet.label || "Unlabelled wallet"}</strong>}
                <code>{wallet.address}</code>
                <small>{wallet.performance ? `Trust ${Number(wallet.performance.trust_score).toFixed(0)} · ${wallet.performance.completed_trades} trades · ${(Number(wallet.performance.win_rate) * 100).toFixed(0)}% win · ${(Number(wallet.performance.average_return) * 100).toFixed(1)}% avg` : "No matched performance history yet"}</small>
              </div>
              <span>{wallet.active ? "ACTIVE" : "INACTIVE"}</span>
              <div className="walletActions">
                {editingAddress === wallet.address ? <>
                  <button type="button" disabled={busy} onClick={() => patchWallet(wallet, { label: editingLabel })}>Save name</button>
                  <button type="button" disabled={busy} onClick={() => setEditingAddress(null)}>Cancel</button>
                </> : <button type="button" disabled={busy} onClick={() => { setEditingAddress(wallet.address); setEditingLabel(wallet.label ?? ""); }}>Rename</button>}
                <button type="button" disabled={busy} onClick={() => patchWallet(wallet, { active: !wallet.active })}>{wallet.active ? "Deactivate" : "Reactivate"}</button>
                <button type="button" disabled={busy} onClick={() => removeWallet(wallet)}>Remove</button>
              </div>
            </div>
          ))}</div>
          <p className="ownerNote">Deactivate pauses future monitoring. Remove deletes the wallet from this list; historical trading records remain separate.</p>
        </>}
        {message && <div className="ownerMessage">{message}</div>}
      </div>}
    </section>
  );
}
