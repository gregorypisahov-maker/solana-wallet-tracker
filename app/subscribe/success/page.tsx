import Link from "next/link";

export default function SubscriptionSuccessPage() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#07100d", color: "#edf8f2", fontFamily: "Inter, system-ui, sans-serif" }}>
      <section style={{ width: "min(560px, 100%)", padding: 36, borderRadius: 24, border: "1px solid rgba(255,255,255,.1)", background: "rgba(255,255,255,.04)", textAlign: "center" }}>
        <div style={{ width: 54, height: 54, margin: "0 auto 18px", display: "grid", placeItems: "center", borderRadius: 16, background: "#39df8a", color: "#031109", fontSize: 28, fontWeight: 900 }}>✓</div>
        <h1 style={{ margin: "0 0 12px", fontSize: 38 }}>Payment received</h1>
        <p style={{ margin: "0 0 28px", color: "#9eb2a8", lineHeight: 1.65 }}>
          Your checkout was completed. Member access becomes active after the secure Stripe webhook confirms the subscription.
        </p>
        <Link href="/" style={{ display: "inline-block", padding: "13px 20px", borderRadius: 11, background: "#39df8a", color: "#031109", fontWeight: 850, textDecoration: "none" }}>
          Return to platform
        </Link>
      </section>
    </main>
  );
}
