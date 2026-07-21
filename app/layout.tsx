import "./globals.css";
import "./professional-loader.css";
import "./mobile-trades.css";
import "./analytics-summary.css";
import "./dashboard-polish.css";
import AnalyticsToneFix from "./AnalyticsToneFix";
import type { ReactNode } from "react";

export const metadata = {
  title: "Solana Smart Wallet Tracker",
  description: "Consensus tracker for top Solana meme-coin wallets",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AnalyticsToneFix />
        {children}
        <a
          href="/wallet-lab"
          style={{
            position: "fixed",
            right: 14,
            bottom: 14,
            zIndex: 100,
            border: "1px solid #2a3a4d",
            borderRadius: 999,
            padding: "9px 13px",
            background: "#111820",
            color: "#8fc0ff",
            textDecoration: "none",
            fontSize: 11,
            boxShadow: "0 8px 24px rgba(0,0,0,.35)",
          }}
        >
          Wallet Lab
        </a>
      </body>
    </html>
  );
}
