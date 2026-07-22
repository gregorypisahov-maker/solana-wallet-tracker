import "./globals.css";
import "./professional-loader.css";
import "./mobile-trades.css";
import "./analytics-summary.css";
import "./dashboard-polish.css";
import AnalyticsToneFix from "./AnalyticsToneFix";
import type { ReactNode } from "react";

export const metadata = {
  title: {
    default: "Solana Intelligence",
    template: "%s | Solana Intelligence",
  },
  description:
    "On-chain wallet intelligence, manipulation-resistant strategy research and transparent Solana paper validation.",
  keywords: [
    "Solana intelligence",
    "wallet tracker",
    "copy trading research",
    "paper trading",
    "on-chain analytics",
  ],
  openGraph: {
    title: "Solana Intelligence",
    description:
      "A multi-strategy on-chain intelligence platform built to test wallet signals before capital is exposed.",
    type: "website",
  },
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
