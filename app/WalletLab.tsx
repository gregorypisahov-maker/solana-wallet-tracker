"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type LabProfile = {
  lab_quality_percent?: number;
  quality_label?: string;
  matched_exits?: number;
  wins?: number;
  losses?: number;
  win_rate?: number;
  profit_factor?: number;
  realized_pnl_sol?: number;
  median_hold_minutes?: number | null;
  copyability_ratio?: number;
  distinct_tokens?: number;
  swaps_per_day?: number;
  qualifies_for_trial?: boolean;
  rejection_reasons?: string[];
  score_breakdown?: Record<string, number>;
};

type Candidate = {
  address: string;
  source: string;
  platform: string;
  status: string;
  scanStatus: string;
  scanRequestedAt: string | null;
  scanStartedAt: string | null;
  scanCompletedAt: string | null;
  scanError: string | null;
  qualityPercent: number | null;
  qualityLabel: string | null;
  profile: LabProfile | null;
  observationCount: number;
  active: boolean;
  liveStatus: string | null;
  label: string | null;
  updatedAt: string;
};

type LabData = {
  generatedAt: string;
  summary: {
    total: number;
    active: number;
    queued: number;
    running: number;
    completed: number;
    qualified: number;
    profiled: number;
  };
  top10: Candidate[];
  candidates: Candidate[];
};

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
const pct = (value: number | null | undefined) =>
  value == null || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const num = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);

function qualityTone(value: number | null) {
  if (value == null) return "pending";
  if (value >= 80) return "excellent";
  if (value >= 65) return "good";
  if (value >= 50) return "watch";
  return "poor";
}

function scanLabel(candidate: Candidate) {
  if (candidate.scanStatus === "running") return "SCANNING";
  if (candidate.scanStatus === "queued") return "QUEUED";
  if (candidate.scanStatus === "error") return "ERROR";
  if (candidate.qualityPercent != null) return `${candidate.qualityPercent}%`;
  return "NOT SCANNED";
}

export default function WalletLab() {
  const [data, setData] = useState<LabData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState("gmgn");
  const [addresses, setAddresses] = useState("");
  const [scanLimit, setScanLimit] = useState(80);
  const [filter, setFilter] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/wallet-lab", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load Wallet Lab");
      setData(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Wallet Lab");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 12_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visibleCandidates = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return data?.candidates ?? [];
    return (data?.candidates ?? []).filter(
      (candidate) =>
        candidate.address.toLowerCase().includes(query) ||
        candidate.platform.toLowerCase().includes(query) ||
        candidate.status.toLowerCase().includes(query) ||
        candidate.qualityLabel?.toLowerCase().includes(query)
    );
  }, [data, filter]);

  function getPassword(): string | null {
    if (ownerPassword) return ownerPassword;
    const entered = window.prompt("Owner password required");
    if (!entered) return null;
    setOwnerPassword(entered);
    return entered;
  }

  async function action(payload: Record<string, unknown>, successMessage: string) {
    const password = getPassword();
    if (!password) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/wallet-lab", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${window.btoa(`owner:${password}`)}`,
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) setOwnerPassword("");
        throw new Error(body.error ?? "Wallet Lab action failed");
      }
      setNotice(successMessage);
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet Lab action failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function importWallets(event: FormEvent) {
    event.preventDefault();
    if (!addresses.trim()) return;
    const ok = await action(
      {
        action: "import",
        platform,
        text: addresses,
        scanLimit,
        priority: true,
      },
      "Wallets added to the Lab and queued for history scans."
    );
    if (ok) setAddresses("");
  }

  async function scan(candidate?: Candidate) {
    await action(
      candidate
        ? { action: "queue_scan", addresses: [candidate.address] }
        : { action: "queue_scan" },
      candidate ? `${short(candidate.address)} queued for a fresh scan.` : "All Wallet Lab candidates queued for fresh scans."
    );
  }

  async function toggle(candidate: Candidate) {
    await action(
      {
        action: candidate.active ? "deactivate" : "activate",
        addresses: [candidate.address],
        label: candidate.label ?? `${candidate.platform} Lab ${short(candidate.address)}`,
      },
      candidate.active ? "Wallet deactivated from live monitoring." : "Wallet activated as a live trial."
    );
  }

  return (
    <div className="v2Stack">
      <section className="v2Kpis">
        <div className="v2Kpi"><small>Lab candidates</small><strong>{data?.summary.total ?? "—"}</strong><span>Across selected platforms</span></div>
        <div className="v2Kpi"><small>History profiled</small><strong>{data?.summary.profiled ?? "—"}</strong><span>With Lab Quality percentage</span></div>
        <div className="v2Kpi"><small>Qualified</small><strong className="positive">{data?.summary.qualified ?? "—"}</strong><span>Passed copyability rules</span></div>
        <div className="v2Kpi"><small>Scan queue</small><strong>{(data?.summary.queued ?? 0) + (data?.summary.running ?? 0)}</strong><span>{data?.summary.running ?? 0} scanning now</span></div>
      </section>

      {error && <div className="v2Toast">{error}</div>}
      {notice && <div className="v2Toast ok">{notice}</div>}

      <section className="v2Panel v2LabImport">
        <div className="v2LabHead">
          <div>
            <h3>Add or scan platform wallets</h3>
            <p>Paste wallet addresses from a leaderboard. They enter the Lab first, receive an on-chain history profile, and are ranked before live activation.</p>
          </div>
          <span>ALCHEMY · HELIUS 0</span>
        </div>
        <form onSubmit={importWallets}>
          <div className="v2LabImportControls">
            <label><span>Platform</span><select value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="gmgn">GMGN</option><option value="birdeye">Birdeye</option><option value="dexcheck">DexCheck</option><option value="manual">Manual research</option></select></label>
            <label><span>History depth</span><select value={scanLimit} onChange={(event) => setScanLimit(Number(event.target.value))}><option value={40}>40 signatures</option><option value={80}>80 signatures</option><option value={120}>120 signatures</option><option value={200}>200 signatures</option></select></label>
            <button type="button" onClick={() => void scan()} disabled={busy}>Scan all Lab wallets</button>
          </div>
          <textarea value={addresses} onChange={(event) => setAddresses(event.target.value)} placeholder="Paste one or many Solana wallet addresses — new lines, spaces, or commas are accepted" spellCheck={false} />
          <button className="v2Save" type="submit" disabled={busy || !addresses.trim()}>{busy ? "Working…" : "Add to Lab + scan history"}</button>
        </form>
      </section>

      <section className="v2Panel">
        <div className="v2Title"><h2>Top 10 wallets to consider</h2><p>Ranked by Lab Quality %. This measures how good the wallet appears for our bot to copy—not merely how much profit GMGN displays.</p></div>
        {!data ? <div className="v2LabEmpty">Loading Wallet Lab ranking…</div> : data.top10.length === 0 ? <div className="v2LabEmpty">No completed history profiles yet. Queued wallets will appear here after scanning.</div> : <div className="v2LabRanking">
          {data.top10.map((candidate, index) => {
            const profile = candidate.profile;
            const quality = candidate.qualityPercent ?? 0;
            return (
              <article className="v2LabRank" key={candidate.address}>
                <div className="v2LabRankNo">#{index + 1}</div>
                <div className={`v2Quality ${qualityTone(candidate.qualityPercent)}`}><strong>{quality}%</strong><span>LAB QUALITY</span></div>
                <div className="v2LabIdentity"><strong>{candidate.label ?? short(candidate.address)}</strong><code>{candidate.address}</code><small>{candidate.platform} · {candidate.active ? "live trial" : candidate.status}</small></div>
                <dl>
                  <div><dt>Profit factor</dt><dd>{num(profile?.profit_factor)}</dd></div>
                  <div><dt>Win rate</dt><dd>{pct(profile?.win_rate)}</dd></div>
                  <div><dt>Realized</dt><dd className={(profile?.realized_pnl_sol ?? 0) >= 0 ? "positive" : "negative"}>{num(profile?.realized_pnl_sol, 3)} SOL</dd></div>
                  <div><dt>Matched exits</dt><dd>{profile?.matched_exits ?? "—"}</dd></div>
                  <div><dt>Copyability</dt><dd>{pct(profile?.copyability_ratio)}</dd></div>
                  <div><dt>Median hold</dt><dd>{num(profile?.median_hold_minutes, 1)}m</dd></div>
                </dl>
                <div className="v2LabActions"><button type="button" disabled={busy} onClick={() => void scan(candidate)}>Rescan</button><button type="button" className={candidate.active ? "danger" : "primary"} disabled={busy} onClick={() => void toggle(candidate)}>{candidate.active ? "Deactivate" : "Activate trial"}</button></div>
              </article>
            );
          })}
        </div>}
      </section>

      <section className="v2Panel">
        <div className="v2Intro split" style={{ padding: 16 }}><div><h2>All Lab wallets</h2><p>Search, rescan, activate, or remove wallets from live monitoring without deleting their research history.</p></div><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search wallet, platform, status…" /></div>
        <div className="v2LabTable">
          <div className="head"><span>Wallet</span><span>Platform</span><span>Quality</span><span>Evidence</span><span>Status</span><span>Actions</span></div>
          {visibleCandidates.slice(0, 100).map((candidate) => (
            <div className="row" key={candidate.address}>
              <div><b>{candidate.label ?? short(candidate.address)}</b><code>{candidate.address}</code></div>
              <div><b>{candidate.platform}</b><small>{candidate.source}</small></div>
              <div><b className={qualityTone(candidate.qualityPercent)}>{scanLabel(candidate)}</b><small>{candidate.qualityLabel ?? candidate.scanStatus}</small></div>
              <div><b>{candidate.profile?.matched_exits ?? 0} exits · PF {num(candidate.profile?.profit_factor)}</b><small>{pct(candidate.profile?.win_rate)} win · {pct(candidate.profile?.copyability_ratio)} copyable</small></div>
              <div><b className={candidate.active ? "positive" : ""}>{candidate.active ? "LIVE TRIAL" : candidate.status.toUpperCase()}</b><small>{candidate.scanError ?? candidate.profile?.rejection_reasons?.[0] ?? "History retained"}</small></div>
              <div className="v2LabActions"><button type="button" disabled={busy} onClick={() => void scan(candidate)}>Scan</button><button type="button" className={candidate.active ? "danger" : "primary"} disabled={busy} onClick={() => void toggle(candidate)}>{candidate.active ? "Pause" : "Activate"}</button></div>
            </div>
          ))}
        </div>
      </section>

      <section className="v2Panel v2LabFormula">
        <div><strong>How Lab Quality % works</strong><p>Profit factor 25% · win rate 25% · realized PnL 15% · sample confidence 15% · copyability 10% · holding-time quality 10%.</p></div>
        <small>Wallets still need enough matched buys and sells. A famous leaderboard wallet can score poorly when its entries are too fast or its profits cannot be copied.</small>
      </section>
    </div>
  );
}
