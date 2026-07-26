"use client";

import { FormEvent, useState } from "react";
import "./subscribe.css";

type PlanId = "signals" | "pro" | "premium";

const plans: Array<{
  id: PlanId;
  name: string;
  price: number;
  description: string;
  featured?: boolean;
  features: string[];
}> = [
  {
    id: "signals",
    name: "Signals",
    price: 29,
    description: "Follow the AI engine without exposing the strategy or controlling the bot.",
    features: ["AI trade-open alerts", "Trade-close alerts", "Member performance dashboard", "Telegram delivery"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 79,
    featured: true,
    description: "For members who want live alerts, deeper statistics and faster decision context.",
    features: ["Everything in Signals", "Advanced trade analytics", "Priority alert delivery", "Daily performance summaries"],
  },
  {
    id: "premium",
    name: "Premium",
    price: 149,
    description: "Full research access plus priority access to future automation features.",
    features: ["Everything in Pro", "Full strategy dashboard", "Research notes", "Priority support"],
  },
];

export default function SubscribePage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function checkout(event: FormEvent, plan: PlanId) {
    event.preventDefault();
    setLoading(plan);
    setError(null);
    try {
      const response = await fetch("/api/subscriptions/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, email }),
      });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error ?? "Checkout could not start.");
      window.location.href = result.url;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Checkout could not start.");
      setLoading(null);
    }
  }

  return (
    <main className="subscribePage">
      <nav className="subscribeNav">
        <a className="subscribeBrand" href="/">
          <span>S</span>
          <div><strong>Solana Intelligence</strong><small>AI trading research</small></div>
        </a>
        <a href="/">Owner dashboard</a>
      </nav>

      <section className="subscribeHero">
        <div className="subscribeBadge">MEMBERSHIP ACCESS</div>
        <h1>Follow the AI trading engine.<br />Keep control of your own capital.</h1>
        <p>Live research alerts, transparent paper performance and member analytics. No guaranteed-profit claims and no custody of customer funds.</p>
      </section>

      <form className="subscribeEmail" onSubmit={(event) => checkout(event, "pro")}>
        <label htmlFor="member-email">Email used for your membership</label>
        <div>
          <input id="member-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
          <button disabled={loading !== null}>{loading ? "Opening checkout…" : "Choose Pro"}</button>
        </div>
        {error && <p className="subscribeError">{error}</p>}
      </form>

      <section className="subscribePlans">
        {plans.map((plan) => (
          <article key={plan.id} className={plan.featured ? "featured" : ""}>
            {plan.featured && <div className="popular">MOST POPULAR</div>}
            <h2>{plan.name}</h2>
            <p>{plan.description}</p>
            <div className="price"><strong>${plan.price}</strong><span>/month</span></div>
            <ul>{plan.features.map((feature) => <li key={feature}>✓ {feature}</li>)}</ul>
            <button disabled={loading !== null} onClick={(event) => checkout(event, plan.id)}>
              {loading === plan.id ? "Opening checkout…" : `Start ${plan.name}`}
            </button>
          </article>
        ))}
      </section>

      <section className="subscribeTrust">
        <div><strong>AI-primary</strong><span>Wallet activity is supporting confirmation, not the main strategy.</span></div>
        <div><strong>Non-custodial first</strong><span>The MVP sells software, analytics and alerts—not management of customer money.</span></div>
        <div><strong>Verified access</strong><span>Paid access will be checked server-side before member data or Telegram alerts are delivered.</span></div>
      </section>

      <footer>Trading involves substantial risk. Historical and paper results do not guarantee future performance.</footer>
    </main>
  );
}
