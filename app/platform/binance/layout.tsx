import type { ReactNode } from "react";
import SolSpotPanel from "./SolSpotPanel";
import SolSpotLiveWallet from "./SolSpotLiveWallet";

export default function BinanceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <SolSpotPanel />
      <section id="sol-spot-live" style={{ background: "#070b12", padding: "0 18px 56px", color: "#f4f7fb" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto" }}>
          <SolSpotLiveWallet />
        </div>
      </section>
    </>
  );
}
