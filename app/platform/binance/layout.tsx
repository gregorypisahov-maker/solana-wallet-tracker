import type { ReactNode } from "react";
import SolSpotPanel from "./SolSpotPanel";

export default function BinanceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <SolSpotPanel />
    </>
  );
}
