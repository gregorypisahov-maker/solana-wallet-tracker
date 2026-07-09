"use client";

import { useEffect, useState, useCallback } from "react";

interface Wallet {
  address: string;
  label: string | null;
  active: boolean;
}

interface TokenScore {
  token_mint: string;
  token_symbol: string | null;
  token_name: string | null;
  wallets_count: number;
  total_sol_bought: number;
  first_buy_time: string | null;
  last_buy_time: string | null;
  market_cap: number | null;
  liquidity_usd: number | null;
  holders: number | null;
  dump_flag: boolean;
  scalp_flag: boolean;
  score: number;
}

function fmtUsd(n: number | null) {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Dashboard() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [tokens, setTokens] = useState<TokenScore[]>([]);
  const [pasteValue, setPasteValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadWallets = useCallback(async () => {
    const res = await fetch("/api/wallets");
    const data = await res.json();
    if (data.wallets) setWallets(data.wallets);
  }, []);

  const loadWatchlist = useCallback(async () => {
    const res = await fetch("/api/watchlist");
    const data = await res.json();
    if (data.tokens) setTokens(data.tokens);
  }, []);

  useEffect(() => {
    loadWallets();
    loadWatchlist();
    const interval = setInterval(loadWatchlist, 30_000);
    return () => clearInterval(interval);
  }, [loadWallets, loadWatchlist]);

  async function addWallets() {
    setError(null);
    const addresses = pasteValue
      .split(/[\n,]+/)
      .map((a) => a.trim())
      .filter(Boolean);

    if (!addresses.length) return;

    setLoading(true);
    const res = await fetch("/api/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses }),
    });
    setLoading(false);

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to add wallets");
      return;
    }
    setPasteValue("");
    loadWallets();
  }

  async function removeWallet(address: string) {
    await fetch("/api/wallets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    loadWallets();
  }

  return (
    <div className="container">
      <h1>Solana Smart Wallet Tracker</h1>
      <p className="subtitle">
        Monitors your chosen wallets and builds a consensus watchlist. This tool never executes
        trades — it only observes and alerts.
      </p>

      <div className="card">
        <h2>Tracked wallets ({wallets.length}/20)</h2>
        <textarea
          placeholder="Paste up to 20 Solana wallet addresses, one per line…"
          value={pasteValue}
          onChange={(e) => setPasteValue(e.target.value)}
        />
        <button onClick={addWallets} disabled={loading}>
          {loading ? "Adding…" : "Add wallets"}
        </button>
        {error && <div className="error">{error}</div>}

        <div className="wallet-list">
          {wallets.length === 0 && <div className="empty">No wallets added yet.</div>}
          {wallets.map((w) => (
            <div className="wallet-row" key={w.address}>
              <span className="wallet-addr">
                {w.address.slice(0, 6)}…{w.address.slice(-6)}
                {w.label && <span className="badge">{w.label}</span>}
              </span>
              <button className="danger" onClick={() => removeWallet(w.address)}>
                remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Consensus watchlist</h2>
        {tokens.length === 0 ? (
          <div className="empty">
            No consensus tokens yet. Once your wallets buy tokens, matches show up here.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>CA</th>
                <th># Wallets</th>
                <th>Total SOL</th>
                <th>First buy</th>
                <th>Last buy</th>
                <th>Mkt cap</th>
                <th>Liquidity</th>
                <th>Holders</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.token_mint}>
                  <td>
                    {t.token_symbol ?? t.token_name ?? "?"}
                    {t.dump_flag && <span className="badge" style={{ color: "#ef4444" }}>dump risk</span>}
                    {t.scalp_flag && <span className="badge" style={{ color: "#f59e0b" }}>scalp</span>}
                  </td>
                  <td>
                    <a
                      className="mono"
                      href={`https://dexscreener.com/solana/${t.token_mint}`}
                      target="_blank"
                    >
                      {t.token_mint.slice(0, 4)}…{t.token_mint.slice(-4)}
                    </a>
                  </td>
                  <td>{t.wallets_count}</td>
                  <td>{t.total_sol_bought.toFixed(2)}</td>
                  <td>{fmtTime(t.first_buy_time)}</td>
                  <td>{fmtTime(t.last_buy_time)}</td>
                  <td>{fmtUsd(t.market_cap)}</td>
                  <td>{fmtUsd(t.liquidity_usd)}</td>
                  <td>{t.holders ?? "—"}</td>
                  <td className={t.score >= 0 ? "score-pos" : "score-neg"}>{t.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
