import "./globals.css";
import type { ReactNode } from "react";
import ShadowDashboardPanel from "./ShadowDashboardPanel";

export const metadata = {
  title: "Solana Smart Wallet Tracker",
  description: "Consensus tracker for top Solana meme-coin wallets",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ShadowDashboardPanel />
      </body>
    </html>
  );
}
