import "./live.css";

export const dynamic = "force-dynamic";

type Gate = { label: string; ready: boolean; detail: string };

export default function LiveTradingPage() {
  const executionEnabled = process.env.LIVE_TRADING_ENABLED === "true";
  const walletConfigured = Boolean(process.env.LIVE_WALLET_PUBLIC_KEY);
  const rpcConfigured = Boolean(process.env.SOLANA_RPC_URL || process.env.ALCHEMY_RPC_URL);
  const signerConfigured = Boolean(process.env.LIVE_WALLET_PRIVATE_KEY);
  const limitsConfigured = Boolean(process.env.LIVE_MAX_POSITION_USD && process.env.LIVE_MAX_DAILY_LOSS_USD);

  const gates: Gate[] = [
    { label: "Dedicated wallet", ready: walletConfigured, detail: walletConfigured ? "Public wallet configured" : "No live wallet public key configured" },
    { label: "Transaction signer", ready: signerConfigured, detail: signerConfigured ? "Signer secret is present" : "No signing key configured" },
    { label: "Solana RPC", ready: rpcConfigured, detail: rpcConfigured ? "RPC provider configured" : "No live RPC configured" },
    { label: "Risk limits", ready: limitsConfigured, detail: limitsConfigured ? "Position and daily-loss limits configured" : "Risk limits are missing" },
    { label: "Execution switch", ready: executionEnabled, detail: executionEnabled ? "LIVE_TRADING_ENABLED=true" : "Execution remains safely disabled" },
  ];

  const readyCount = gates.filter((gate) => gate.ready).length;
  const fullyReady = readyCount === gates.length;

  return (
    <main className="livePage">
      <nav className="liveNav">
        <a href="/">← Platform</a>
        <a href="/subscribe">Subscriptions</a>
      </nav>

      <section className="liveHero">
        <div className={fullyReady ? "status ready" : "status safe"}>{fullyReady ? "LIVE READY" : "FAIL-CLOSED"}</div>
        <h1>Live Trading Control Center</h1>
        <p>Real-money execution is separated from paper research and remains disabled until every operational and risk gate passes.</p>
      </section>

      <section className="liveGrid">
        <article className="summaryCard">
          <span>Readiness</span>
          <strong>{readyCount}/{gates.length}</strong>
          <small>{fullyReady ? "All configuration gates pass" : "No real trades can be sent yet"}</small>
        </article>
        <article className="summaryCard">
          <span>Execution</span>
          <strong>{executionEnabled ? "ON" : "OFF"}</strong>
          <small>{executionEnabled ? "Requires final wallet test" : "Protected by default"}</small>
        </article>
        <article className="summaryCard">
          <span>Paper engine</span>
          <strong>SEPARATE</strong>
          <small>Paper research can continue alongside live mode</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeading">
          <div><span>PRE-LIVE GATES</span><h2>Nothing trades until all five pass</h2></div>
        </div>
        <div className="gateList">
          {gates.map((gate) => (
            <div className="gate" key={gate.label}>
              <div className={gate.ready ? "dot ok" : "dot"} />
              <div><strong>{gate.label}</strong><small>{gate.detail}</small></div>
              <b>{gate.ready ? "READY" : "BLOCKED"}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="panel riskPanel">
        <span>DEFAULT LIVE LIMITS</span>
        <h2>Designed for the first small-capital test</h2>
        <div className="riskGrid">
          <div><strong>$25</strong><small>maximum position</small></div>
          <div><strong>$50</strong><small>maximum daily loss</small></div>
          <div><strong>1</strong><small>open position</small></div>
          <div><strong>$100</strong><small>wallet reserve</small></div>
        </div>
        <p>These are database defaults only. They do not activate execution and should be reviewed before funding.</p>
      </section>

      <section className="panel">
        <span>INVESTOR ACCOUNTING</span>
        <h2>Built for two equal contributors</h2>
        <div className="investorRows">
          <div><span>Investor A</span><strong>$500 contribution</strong><b>50%</b></div>
          <div><span>Investor B</span><strong>$500 contribution</strong><b>50%</b></div>
        </div>
        <p>No investor records are inserted automatically. Names, deposits and ownership units must be entered only after the funds actually arrive in the dedicated wallet.</p>
      </section>

      <footer>Real trading carries substantial risk. Paper performance does not guarantee live results.</footer>
    </main>
  );
}
