import type { ReactNode } from "react";

const mobileSignalFix = `
@media (max-width: 720px) {
  .sfSignalMap > .sfBeam {
    display: none !important;
  }

  .sfSignalMap > .sfCorePulse {
    display: none !important;
  }

  .sfSignalMap::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: 0.9;
    background-repeat: no-repeat;
    background-position: center;
    background-size: 100% 100%;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 100 100' preserveAspectRatio='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3ClinearGradient id='g1' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%2362d9ff' stop-opacity='.08'/%3E%3Cstop offset='.5' stop-color='%2362d9ff' stop-opacity='.72'/%3E%3Cstop offset='1' stop-color='%2358f0a6' stop-opacity='.13'/%3E%3C/linearGradient%3E%3ClinearGradient id='g2' x1='1' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23a987ff' stop-opacity='.08'/%3E%3Cstop offset='.5' stop-color='%23a987ff' stop-opacity='.68'/%3E%3Cstop offset='1' stop-color='%2358f0a6' stop-opacity='.13'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M43 15 C43 24 39 31 36 38' fill='none' stroke='url(%23g1)' stroke-width='.45' vector-effect='non-scaling-stroke'/%3E%3Cpath d='M57 15 C57 24 61 31 64 38' fill='none' stroke='url(%23g2)' stroke-width='.45' vector-effect='non-scaling-stroke'/%3E%3Cpath d='M36 59 C39 66 43 71 43 77' fill='none' stroke='url(%23g1)' stroke-width='.45' vector-effect='non-scaling-stroke'/%3E%3Cpath d='M64 59 C61 66 57 71 57 77' fill='none' stroke='url(%23g2)' stroke-width='.45' vector-effect='non-scaling-stroke'/%3E%3Ccircle cx='40.5' cy='28' r='.75' fill='%23d8f8ff'/%3E%3Ccircle cx='59.5' cy='28' r='.75' fill='%23d9ccff'/%3E%3Ccircle cx='40.5' cy='68.5' r='.75' fill='%23b9f9db'/%3E%3Ccircle cx='59.5' cy='68.5' r='.75' fill='%23b9f9db'/%3E%3C/svg%3E");
  }

  .sfSignalMap > .sfNode {
    z-index: 2;
  }
}
`;

export default function StorefrontLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: mobileSignalFix }} />
      {children}
    </>
  );
}
