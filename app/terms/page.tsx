import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms | Solana Intelligence",
  description: "Terms of use for the Solana Intelligence research platform.",
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#050913", color: "#e8eef8", padding: "72px 20px", fontFamily: "system-ui, sans-serif" }}>
      <article style={{ maxWidth: 820, margin: "0 auto", border: "1px solid rgba(160,180,220,.18)", borderRadius: 24, padding: "clamp(24px,5vw,54px)", background: "rgba(10,16,28,.88)", boxShadow: "0 30px 90px rgba(0,0,0,.35)" }}>
        <small style={{ letterSpacing: ".16em", textTransform: "uppercase", color: "#73efb0" }}>Proprietary platform</small>
        <h1 style={{ fontSize: "clamp(34px,6vw,60px)", lineHeight: 1.02, margin: "18px 0 22px" }}>Terms of use</h1>
        <p style={{ color: "#aebbd0", lineHeight: 1.75 }}>
          Solana Intelligence is a private, proprietary paper-trading research platform. The public website is provided only to demonstrate high-level capabilities and research progress.
        </p>
        <h2 style={{ marginTop: 34 }}>No copying or reverse engineering</h2>
        <p style={{ color: "#aebbd0", lineHeight: 1.75 }}>
          You may not copy, reproduce, scrape, reverse engineer, resell, redistribute, or create a competing derivative product from the platform, its private software, decision logic, data structures, interfaces, documentation, or branding without written permission.
        </p>
        <h2 style={{ marginTop: 34 }}>Research only</h2>
        <p style={{ color: "#aebbd0", lineHeight: 1.75 }}>
          All displayed trading results are paper-research results. Nothing on this website is financial advice, a promise of performance, or a solicitation to invest. Cryptocurrency and memecoin trading can result in complete loss.
        </p>
        <h2 style={{ marginTop: 34 }}>Access</h2>
        <p style={{ color: "#aebbd0", lineHeight: 1.75 }}>
          Private-platform access is revocable and may be monitored for security. Attempted unauthorized access, credential sharing, automated extraction, or interference with the service is prohibited.
        </p>
        <p style={{ marginTop: 42, color: "#75849b", fontSize: 13 }}>© 2026 Solana Intelligence. All rights reserved.</p>
        <Link href="/" style={{ display: "inline-flex", marginTop: 22, color: "#dffff0", textDecoration: "none", border: "1px solid rgba(88,240,166,.35)", borderRadius: 999, padding: "12px 18px" }}>← Return to storefront</Link>
      </article>
    </main>
  );
}
