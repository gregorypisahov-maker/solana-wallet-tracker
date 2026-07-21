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
      </body>
    </html>
  );
}
