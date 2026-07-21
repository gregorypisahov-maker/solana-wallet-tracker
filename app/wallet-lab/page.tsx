"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "../platform-v2.css";

type Candidate = {
  wallet_address: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number | string;
  leaderboard_score: number | string;
  final_profile?: Record<string, any> | null;
  lab_trust_score?: number | string | null;
  profiled_at?: string | null;
  rejection_reasons?: string[];
  promoted_at?: string | null;
};

type LabData = {
  candidates: Candidate[];
  runs: any[];
  signals: any[];
  activeTrials: Candidate[];
};

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
const n = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const israelTime = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-IL", {
        timeZone: "Asia/Jerusalem",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "—";

function observationAge(candidate: Candidate): string {
  const hours = Math.max(0, (Date.now() - Date.parse(candidate.first_seen_at)) / 3_600_000);
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}

function statusTone(status: string): string {
  if (status === "qualified" || status === "trial") return "active";
  if (status === "rejected" || status === "disabled") return "offline";
  return "paused";
}

export default function WalletLabPage() {
  const [lab, setLab] = useState<LabData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/compact-dashboard", { cache: "no-store" });
      if (response.status === 401) {
        setError("Open the main dashboard and log in first.");
        setLab(null);
        return;
      }
      if (!response.ok) throw new Error("Could not load Wallet Lab");
      const payload = await response.json();
      setLab(payload.walletLab);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load Wallet Lab");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const candidates = useMemo(() => {
    if (!lab) return [];
    const priority: Record<string, number> = {
      trial: 0,
      qualified: 1,
      profile_pending: 2,
      observing: 3,
      rejected: 4,
      disabled: 5,
    };
    return [...lab.candidates].sort(
      (a, b) =>
        (priority[a.status] ?? 9) - (priority[b.status] ?? 9) ||
        n(b.leaderboard_score) - n(a.leaderboard_score)
    );
  }, [lab]);

  const control = async (candidate: Candidate, action: "promote" | "disable") => {
    const password = prompt(`Owner password required to ${action} ${short(candidate.wallet_address)}`);
    if (!password) return;
    const response = await fetch("/api/wallet-lab/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`owner:${password}`)}`,
      },
      body: JSON.stringify({ walletAddress: candidate.wallet_address, action }),
    });
    const result = await response.json().catch(() => ({}));
    setNotice(response.ok ? result.message ?? "Wallet Lab updated" : result.error ?? "Update failed");
    await refresh();
  };

  if (!lab) {
    return (
      <main className="v2Detail">
        <a href="/" style={{ color: "#8d99a8", textDecoration: "none" }}>← Main dashboard</a>
        <section className="v2Panel" style={{ padding: 22 }}>
          <h1>Wallet Discovery Lab</h1>
          <p style={{ color: "#8d99a8" }}>{error ?? "Loading candidate observations…"}</p>
        </section>
      </main>
    );
  }

  const lastRun = lab.runs[0];
  const observing = lab.candidates.filter((candidate) => candidate.status === "observing").length;
  const qualified = lab.candidates.filter((candidate) => candidate.status === "qualified").length;

  return (
    <main className="v2Detail">
      <a href="/" style={{ color: "#8d99a8", textDecoration: "none" }}>← Main dashboard</a>
      <section className="v2Panel" style={{ padding: 20 }}>
        <div className="v2LabHead">
          <div>
            <h1 style={{ margin: 0 }}>Wallet Discovery Lab</h1>
            <p>
              Observes a large public wallet pool for 72–96 hours, profiles only mature finalists,
              and feeds a maximum of two wallets to the isolated Lab Shadow and Lab Legion bots.
            </p>
          </div>
          <span>Core bots isolated</span>
        </div>
      </section>

      {error && <div className="v2Toast">{error}</div>}
      {notice && <div className="v2Toast ok">{notice}</div>}

      <section className="v2Kpis">
        <div className="v2Kpi"><small>Candidates stored</small><strong>{lab.candidates.length}</strong><span>{observing} still observing</span></div>
        <div className="v2Kpi"><small>Qualified finalists</small><strong className="positive">{qualified}</strong><span>Owner review required</span></div>
        <div className="v2Kpi"><small>Active lab wallets</small><strong>{lab.activeTrials.length}/2</strong><span>Separate 60-second intake</span></div>
        <div className="v2Kpi"><small>Latest scan</small><strong>{lastRun?.status ?? "—"}</strong><span>{israelTime(lastRun?.finished_at ?? lastRun?.started_at)}</span></div>
      </section>

      <section className="v2Panel">
        <div className="v2Title">
          <h2>Candidate ranking</h2>
          <p>Leaderboard evidence first; Helius is used only after the observation period.</p>
        </div>
        <div className="v2Trades" style={{ marginTop: 12 }}>
          <div className="head" style={{ gridTemplateColumns: "1.15fr .8fr .8fr 1.2fr .9fr" }}>
            <span>Wallet</span><span>Status</span><span>Observation</span><span>Final profile</span><span>Action</span>
          </div>
          {candidates.map((candidate) => {
            const profile = candidate.final_profile ?? {};
            const canPromote = candidate.status === "qualified" && lab.activeTrials.length < 2;
            const canDisable = ["qualified", "trial"].includes(candidate.status);
            return (
              <div
                className="row"
                key={candidate.wallet_address}
                style={{ gridTemplateColumns: "1.15fr .8fr .8fr 1.2fr .9fr" }}
              >
                <span>
                  <b>{short(candidate.wallet_address)}</b>
                  <small>Lab score {n(candidate.leaderboard_score).toFixed(1)}</small>
                </span>
                <span>
                  <span className={`v2Badge ${statusTone(candidate.status)}`}>{candidate.status.replaceAll("_", " ")}</span>
                  <small>{candidate.rejection_reasons?.[0] ?? ""}</small>
                </span>
                <span>
                  <b>{observationAge(candidate)}</b>
                  <small>{n(candidate.observation_count)} observations</small>
                </span>
                <span>
                  <b>{profile.closedTrades ? `${profile.closedTrades} trades · PF ${n(profile.profitFactor).toFixed(2)}` : "Waiting for maturity"}</b>
                  <small>
                    {profile.closedTrades
                      ? `${(n(profile.winRate) * 100).toFixed(0)}% win · ${n(profile.realizedPnlSol).toFixed(3)} SOL · trust ${n(candidate.lab_trust_score).toFixed(1)}`
                      : `Last seen ${israelTime(candidate.last_seen_at)}`}
                  </small>
                </span>
                <span style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  {canPromote && <button className="v2Save" style={{ margin: 0, padding: "7px 9px" }} onClick={() => void control(candidate, "promote")}>Promote</button>}
                  {canDisable && <button style={{ border: 0, borderRadius: 8, padding: "7px 9px", background: "rgba(255,111,127,.12)", color: "#ff6f7f" }} onClick={() => void control(candidate, "disable")}>Disable</button>}
                  {!canPromote && !canDisable && <small>No action yet</small>}
                </span>
              </div>
            );
          })}
          {candidates.length === 0 && <div className="row"><span>First scan has not stored candidates yet.</span></div>}
        </div>
      </section>

      <section className="v2Panel" style={{ padding: 18 }}>
        <h2 style={{ marginTop: 0 }}>Latest scan audit</h2>
        <p style={{ color: "#8d99a8", fontSize: 11 }}>
          {lastRun
            ? `${lastRun.unique_count ?? 0} unique wallets observed · ${lastRun.profiled_count ?? 0} finalists profiled · ${lastRun.helius_calls ?? 0} Helius calls · ${lastRun.qualified_count ?? 0} newly qualified.`
            : "No completed scan yet."}
        </p>
        <div className="v2Warning">
          Promotion does not affect the original Legion or Shadow wallet pool. Lab wallets use their own transactions,
          signals, bankrolls, positions and trades.
        </div>
      </section>
    </main>
  );
}
