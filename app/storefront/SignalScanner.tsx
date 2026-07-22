"use client";

import { useEffect } from "react";

const scannerSvg = `
<svg viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <filter id="sfGlowCyan" x="-500%" y="-500%" width="1000%" height="1000%">
      <feGaussianBlur stdDeviation="1.15" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="sfGlowViolet" x="-500%" y="-500%" width="1000%" height="1000%">
      <feGaussianBlur stdDeviation="1.1" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="sfGlowGreen" x="-500%" y="-500%" width="1000%" height="1000%">
      <feGaussianBlur stdDeviation="1.2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <path id="sfScanLT" d="M43 15 C43 24 39 31 36 38" fill="none" stroke="#62d9ff" stroke-opacity=".34" stroke-width=".22" stroke-dasharray="1.4 2.2" vector-effect="non-scaling-stroke">
    <animate attributeName="stroke-dashoffset" from="0" to="-14" dur="3.4s" repeatCount="indefinite"/>
  </path>
  <path id="sfScanRT" d="M57 15 C57 24 61 31 64 38" fill="none" stroke="#a987ff" stroke-opacity=".34" stroke-width=".22" stroke-dasharray="1.4 2.2" vector-effect="non-scaling-stroke">
    <animate attributeName="stroke-dashoffset" from="0" to="-14" dur="3.8s" repeatCount="indefinite"/>
  </path>
  <path id="sfScanLB" d="M36 59 C39 66 43 71 43 77" fill="none" stroke="#58f0a6" stroke-opacity=".32" stroke-width=".22" stroke-dasharray="1.4 2.2" vector-effect="non-scaling-stroke">
    <animate attributeName="stroke-dashoffset" from="0" to="-14" dur="3.6s" repeatCount="indefinite"/>
  </path>
  <path id="sfScanRB" d="M64 59 C61 66 57 71 57 77" fill="none" stroke="#58f0a6" stroke-opacity=".32" stroke-width=".22" stroke-dasharray="1.4 2.2" vector-effect="non-scaling-stroke">
    <animate attributeName="stroke-dashoffset" from="0" to="-14" dur="4.1s" repeatCount="indefinite"/>
  </path>

  <g fill="#d9f8ff" filter="url(#sfGlowCyan)">
    <circle r=".72"><animateMotion dur="3.8s" repeatCount="indefinite" begin="0s"><mpath href="#sfScanLT" xlink:href="#sfScanLT"/></animateMotion><animate attributeName="opacity" values=".2;1;.2" dur="1.7s" repeatCount="indefinite"/></circle>
    <circle r=".48"><animateMotion dur="3.8s" repeatCount="indefinite" begin="-1.9s"><mpath href="#sfScanLT" xlink:href="#sfScanLT"/></animateMotion><animate attributeName="opacity" values=".15;.85;.15" dur="1.5s" repeatCount="indefinite"/></circle>
  </g>
  <g fill="#ded3ff" filter="url(#sfGlowViolet)">
    <circle r=".72"><animateMotion dur="4.2s" repeatCount="indefinite" begin="-.6s"><mpath href="#sfScanRT" xlink:href="#sfScanRT"/></animateMotion><animate attributeName="opacity" values=".2;1;.2" dur="1.9s" repeatCount="indefinite"/></circle>
    <circle r=".48"><animateMotion dur="4.2s" repeatCount="indefinite" begin="-2.7s"><mpath href="#sfScanRT" xlink:href="#sfScanRT"/></animateMotion><animate attributeName="opacity" values=".15;.85;.15" dur="1.6s" repeatCount="indefinite"/></circle>
  </g>
  <g fill="#bafadd" filter="url(#sfGlowGreen)">
    <circle r=".72"><animateMotion dur="4s" repeatCount="indefinite" begin="-1.1s"><mpath href="#sfScanLB" xlink:href="#sfScanLB"/></animateMotion><animate attributeName="opacity" values=".2;1;.2" dur="1.8s" repeatCount="indefinite"/></circle>
    <circle r=".48"><animateMotion dur="4s" repeatCount="indefinite" begin="-3.1s"><mpath href="#sfScanLB" xlink:href="#sfScanLB"/></animateMotion><animate attributeName="opacity" values=".15;.85;.15" dur="1.45s" repeatCount="indefinite"/></circle>
    <circle r=".72"><animateMotion dur="4.45s" repeatCount="indefinite" begin="-.2s"><mpath href="#sfScanRB" xlink:href="#sfScanRB"/></animateMotion><animate attributeName="opacity" values=".2;1;.2" dur="2s" repeatCount="indefinite"/></circle>
    <circle r=".48"><animateMotion dur="4.45s" repeatCount="indefinite" begin="-2.45s"><mpath href="#sfScanRB" xlink:href="#sfScanRB"/></animateMotion><animate attributeName="opacity" values=".15;.85;.15" dur="1.6s" repeatCount="indefinite"/></circle>
  </g>

  <circle cx="50" cy="49" r="1.2" fill="none" stroke="#58f0a6" stroke-width=".24" opacity="0">
    <animate attributeName="r" values="1.2;5.5" dur="2.8s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values=".7;0" dur="2.8s" repeatCount="indefinite"/>
  </circle>
</svg>`;

export default function SignalScanner() {
  useEffect(() => {
    const signalMap = document.querySelector<HTMLElement>(".sfSignalMap");
    if (!signalMap || signalMap.querySelector(".sfLivePacketLayer")) return;

    const layer = document.createElement("div");
    layer.className = "sfLivePacketLayer";
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML = scannerSvg;
    signalMap.prepend(layer);

    return () => layer.remove();
  }, []);

  return null;
}
