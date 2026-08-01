"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import styles from "./sol-dashboard-shell.module.css";

type AccessState = "checking" | "locked" | "ready";

export default function BinanceDashboardPage() {
  const [access, setAccess] = useState<AccessState>("checking");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkAccess = useCallback(async () => {
    try {
      const response = await fetch("/api/sol-spot-paper", { cache: "no-store" });
      if (response.status === 401) {
        setAccess("locked");
        return;
      }
      if (!response.ok) throw new Error("Could not open the SOL/USDT dashboard");
      setAccess("ready");
      setError(null);
    } catch (cause) {
      setAccess("locked");
      setError(cause instanceof Error ? cause.message : "Could not open the dashboard");
    }
  }, []);

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/viewer-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) throw new Error("Wrong dashboard password");
      setPassword("");
      await checkAccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not unlock the dashboard");
    } finally {
      setSubmitting(false);
    }
  };

  if (access === "checking") {
    return (
      <main className={styles.login}>
        <div className={styles.loading}>
          <div className={styles.coin}>◎</div>
          <h1>SOL/USDT Dashboard</h1>
          <p>Loading the spot strategy and wallet controls…</p>
        </div>
      </main>
    );
  }

  if (access === "locked") {
    return (
      <main className={styles.login}>
        <form onSubmit={login}>
          <div className={styles.coin}>◎</div>
          <h1>SOL/USDT Dashboard</h1>
          <p>Use the private platform password to view the paper bot and optional wallet-approved real execution.</p>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Dashboard password"
            autoComplete="current-password"
            autoFocus
          />
          <button type="submit" disabled={submitting || !password.trim()}>
            {submitting ? "Unlocking…" : "Open SOL dashboard"}
          </button>
          {error && <small className={styles.error}>{error}</small>}
        </form>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <div className={styles.topbar}>
          <div className={styles.brand}>
            <div className={styles.coin}>◎</div>
            <div>
              <h1>SOL/USDT Trading Dashboard</h1>
              <p>Spot paper strategy with optional wallet-approved real SOL ↔ USDT execution.</p>
            </div>
          </div>
          <nav className={styles.actions} aria-label="SOL dashboard sections">
            <a href="#sol-spot-paper">Paper bot</a>
            <a href="#sol-spot-live">Wallet controls</a>
            <a href="/platform">Platform</a>
          </nav>
        </div>
        <div className={styles.note}>
          The legacy Bitcoin futures trader has been removed from this website. This page now shows only the SOL/USDT system.
        </div>
      </section>
    </main>
  );
}
