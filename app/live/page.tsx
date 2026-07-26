import "./live.css";
import { getLiveWalletHealth } from "@/lib/liveWallet";

export const dynamic = "force-dynamic";

type Gate = { label: string; ready: boolean; detail: string };

export default async function LiveTradingPage() {
  const health = await getLiveWalletHealth();
  const limitsConfigured = Boolean(process.env.LIVE_MAX_POSITION_USD && process.env.LIVE_MAX_DAILY_LOSS_USD);
  const databaseControlsConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

  const gates: Gate[] = [
    { label: "Dedicated wallet address", ready: Boolean(health.publicKey), detail: health.publicKey ? `${health.publicKey.slice(0, 6)}…${health.publicKey.slice(-6)}` : "Add LIVE_WALLET_PUBLIC_KEY in the Railway worker and dashboard" },
    { label: "Transaction signer", ready: health.signerConfigured, detail: health.signerConfigured ? "Signing secret is present and never exposed to the browser" : "Add LIVE_WALLET_PRIVATE_KEY only to the Railway worker" },
    { label: "Solana RPC", ready: health.rpcConfigured, detail: health.rpcConfigured ? "RPC provider configured" : "Add SOLANA_RPC_URL or ALCHEMY_RPC_URL" },
    { label: "Database controls", ready: databaseControlsConfigured, detail: databaseControlsConfigured ? "Live controls and audit storage available" : "Supabase service credentials are missing" },
    { label: "Risk limits", ready: limitsConfigured, detail: limitsConfigured ? "Position and daily-loss limits configured" : "Add LIVE_MAX_POSITION_USD and LIVE_MAX_DAILY_LOSS_USD" },
    { label: "Execution enabled", ready: health.enabled, detail: health.enabled ? "LIVE_TRADING_ENABLED=true" : "Safely disabled" },
    { label: "Final execution arm", ready: health.armed, detail: health.armed ? "LIVE_EXECUTION_ARMED=true" : "Second safety lock remains off" },
  ];

  const readyCount = gates.filter((gate) => gate.ready).length;
  const fullyReady = readyCount === gates.length;

  return (
    <main className="livePage">
      <nav className="liveNav"><a href="/platform">← Platform</a><a href="/subscribe">Subscriptions</a></nav>
      <section className="liveHero">
        <div className={fullyReady ? "status ready" : "status safe"}>{fullyReady ? "LIVE READY" : "FAIL-CLOSED"}</div>
        <h1>Live Trading Control Center</h1>
        <p>The real executor is installed, but it cannot send a transaction until the wallet, database controls and both execution locks are configured.</p>
      </section>

      <section className="liveGrid">
        <article className="summaryCard"><span>Readiness</span><strong>{readyCount}/{gates.length}</strong><small>{fullyReady ? "All configuration gates pass" : "Real trades remain blocked"}</small></article>
        <article className="summaryCard"><span>Wallet balance</span><strong>{health.balanceSol == null ? "—" : `${health.balanceSol.toFixed(4)} SOL`}</strong><small>{health.error ?? (health.publicKey ? "On-chain confirmed balance" : "Wallet not connected")}</small></article>
        <article className="summaryCard"><span>Execution</span><strong>{health.enabled && health.armed ? "ARMED" : "OFF"}</strong><small>Two independent Railway switches are required</small></article>
      </section>

      <section className="panel">
        <div className="panelHeading"><div><span>LIVE WALLET</span><h2>Connection happens in Railway, not in the browser</h2></div></div>
        <div className="gateList">
          {gates.map((gate) => <div className="gate" key={gate.label}><div className={gate.ready ? "dot ok" : "dot"}/><div><strong>{gate.label}</strong><small>{gate.detail}</small></div><b>{gate.ready ? "READY" : "BLOCKED"}</b></div>)}
        </div>
      </section>

      <section className="panel riskPanel">
        <span>EXECUTOR V1</span><h2>Guarded Jupiter swap execution</h2>
        <div className="riskGrid"><div><strong>0.1 SOL</strong><small>hard maximum test buy</small></div><div><strong>0.02 SOL</strong><small>minimum remaining reserve</small></div><div><strong>2 locks</strong><small>enabled and armed</small></div><div><strong>Owner only</strong><small>admin password required</small></div></div>
        <p>The test endpoint requires the exact confirmation phrase, owner authentication, database emergency stop off, available position capacity, and both Railway execution switches. Automated AI mirroring is not enabled yet.</p>
      </section>

      <section className="panel">
        <span>RAILWAY VARIABLES TO ADD</span><h2>Dedicated wallet configuration</h2>
        <div className="investorRows">
          <div><span>Dashboard + worker</span><strong>LIVE_WALLET_PUBLIC_KEY</strong><b>PUBLIC</b></div>
          <div><span>Worker only</span><strong>LIVE_WALLET_PRIVATE_KEY</strong><b>SECRET</b></div>
          <div><span>Dashboard + worker</span><strong>SOLANA_RPC_URL</strong><b>SECRET</b></div>
          <div><span>Keep false initially</span><strong>LIVE_TRADING_ENABLED</strong><b>LOCK 1</b></div>
          <div><span>Keep false initially</span><strong>LIVE_EXECUTION_ARMED</strong><b>LOCK 2</b></div>
        </div>
        <p>Never paste the private key into the website, GitHub, Telegram, or this chat. It belongs only in the Railway worker service secret variables.</p>
      </section>
      <footer>Real trading carries substantial risk. Paper performance does not guarantee live results.</footer>
    </main>
  );
}
