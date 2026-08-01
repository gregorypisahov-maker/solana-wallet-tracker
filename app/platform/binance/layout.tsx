import type { ReactNode } from "react";
import SolSpotPanel from "./SolSpotPanel";
import SolSpotAutoPanel from "./SolSpotAutoPanel";

export default function BinanceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <SolSpotPanel />
      <section
        id="sol-spot-auto"
        style={{
          background: "#070b12",
          padding: "0 18px calc(180px + env(safe-area-inset-bottom, 0px))",
          color: "#f4f7fb",
          scrollMarginTop: 18,
          scrollPaddingBottom: "calc(180px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        <div style={{ maxWidth: 1440, margin: "0 auto" }}>
          <SolSpotAutoPanel />
        </div>
      </section>
    </>
  );
}
