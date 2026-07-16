"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import LiveTimeline from "./LiveTimeline";

type Wallet = {
  address: string;
  label: string | null;
  active: boolean;
  created_at: string;
  performance: { trust_score: number; completed_trades: number; win_rate: number; average_return: number } | null;
};

type OpsData = {
  generatedAt: string;
  health: Array<{ name: string; ok: boolean; detail: string }>;
  wallets: {
    proven: number;
    trial: number;
    total: number;
    promotedLastRun: number;
    disabledLastRun: number;
    replacementsLastRun: number;
    leaders: Array<{ wallet_address: string; trust_score: number; completed_trades: number; win_rate: number; profit_factor: number | null }>;
  };
  decisions: Array<{ token: string; mint: string; score: number; wallets: number; updatedAt: string | null; accepted: boolean; reasons: string[] }>;
  coach: string[];
};

type Props = { onChanged: () => void };

const ago = (value: string | null) => {
  if (!value) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

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
  const [ops, setOps] = useState<OpsData | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);

  const authorization = (value = password) => ({ Authorization: `Basic ${window.btoa(`owner:${value}`)}` });

  const loadOps = useCallback(async () => {
    try {
      const response = await fetch("/api/command-center", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load Command Center status");
      setOps(body);
      setOpsError(null);
    } catch (error) {
      setOpsError(error instanceof Error ? error.message : "Could not load Command Center status");
    }
  }, []);

  useEffect(() => {
    void loadOps();
    const timer = window.setInterval(() => void loadOps(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadOps]);

  async function readWallets(passwordValue = password) {
    const response = await fetch("/api/wallets", { cache: "no-store", headers: authorization(passwordValue) });
    const body = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "Incorrect owner password" : body.error ?? "Could not load wallets");
    setWallets(body.wallets);
  }

  async function finishChange(successMessage: string) {
    await readWallets();
    onChanged();
    await loadOps();
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
    <>
      <LiveTimeline />
      <section className="grid two" style={{ marginBottom: 18 }}>
        <section className="panel">
          <div className="panelHead"><h2>Bot health</h2><span>{ops?.health.every((item) => item.ok) ? "ALL SYSTEMS" : "ATTENTION"}</span></div>
          {opsError ? <div className="errorBanner">{opsError}</div> : !ops ? <div className="empty">Loading operational status…</div> : <div className="feed">
            {ops.health.map((item) => <div className="feedRow" key={item.name}><i className={item.ok ? "up" : "down"}>{item.ok ? "✓" : "!"}</i><div><strong>{item.name}</strong><small>{item.detail}</small></div><div className="feedValue"><b className={item.ok ? "green" : "red"}>{item.ok ? "HEALTHY" : "CHECK"}</b></div></div>)}
          </div>}
        </section>
        <section className="panel">
          <div className="panelHead"><h2>Wallet intelligence</h2><span>AUTOMATIC</span></div>
          {!ops ? <div className="empty">Loading wallet intelligence…</div> : <div className="stack" style={{ padding: 14 }}>
            <div className="position"><div><strong>Active pool</strong><span>Protected + testing</span></div><div><span>Proven</span><b>{ops.wallets.proven}</b></div><div><span>Trials</span><b>{ops.wallets.trial}</b></div><div><span>Total</span><b>{ops.wallets.total}</b></div></div>
            <div className="position"><div><strong>Last evaluation</strong><span>Automatic rotation</span></div><div><span>Promoted</span><b>{ops.wallets.promotedLastRun}</b></div><div><span>Disabled</span><b>{ops.wallets.disabledLastRun}</b></div><div><span>Replaced</span><b>{ops.wallets.replacementsLastRun}</b></div></div>
            {ops.wallets.leaders.slice(0, 3).map((wallet, index) => <div className="position" key={wallet.wallet_address}><div><strong>#{index + 1} {wallet.wallet_address}</strong><span>{wallet.completed_trades} matched trades</span></div><div><span>Trust</span><b>{Number(wallet.trust_score).toFixed(0)}</b></div><div><span>Win</span><b>{(Number(wallet.win_rate) * 100).toFixed(0)}%</b></div><div><span>PF</span><b>{wallet.profit_factor == null ? "—" : Number(wallet.profit_factor).toFixed(2)}</b></div></div>)}
          </div>}
        </section>
      </section>

      <section className="grid two" style={{ marginBottom: 18 }}>
        <section className="panel">
          <div className="panelHead"><h2>Entry decision viewer</h2><span>LATEST SIGNALS</span></div>
          {!ops ? <div className="empty">Loading decisions…</div> : <div className="feed">{ops.decisions.slice(0, 8).map((decision) => <div className="feedRow" key={decision.mint}><i className={decision.accepted ? "up" : "down"}>{decision.accepted ? "✓" : "×"}</i><div><strong>{decision.token} · score {decision.score}</strong><small>{decision.reasons[0]}</small></div><div className="feedValue"><b className={decision.accepted ? "green" : "red"}>{decision.accepted ? "PASS" : "REJECT"}</b><small>{decision.wallets} wallets · {ago(decision.updatedAt)}</small></div></div>)}</div>}
        </section>
        <section className="panel">
          <div className="panelHead"><h2>Strategy coach</h2><span>AUTO REVIEW</span></div>
          {!ops ? <div className="empty">Preparing analysis…</div> : <div className="stack" style={{ padding: 16 }}>{ops.coach.map((line, index) => <div className="position" key={index} style={{ gridTemplateColumns: "38px 1fr" }}><div><strong>{index + 1}</strong></div><div><b>{line}</b></div></div>)}</div>}
        </section>
      </section>

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
    </>
  );
}
