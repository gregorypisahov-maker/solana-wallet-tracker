"use client";

import { useEffect } from "react";

function parseSol(text: string | null | undefined) {
  if (!text) return Number.NaN;
  const match = text.replace(/,/g, "").match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function applyAnalyticsTone() {
  const summary = document.querySelector<HTMLElement>(".analyticsSummary");
  if (!summary) return;

  const headline = summary.querySelector<HTMLHeadingElement>(".summaryHeadline h2");
  const quickCards = summary.querySelectorAll<HTMLElement>(".summaryQuick > div");
  const narrative = summary.querySelector<HTMLParagraphElement>(".summaryNarrative > p");
  const recent48 = parseSol(quickCards[1]?.querySelector("strong")?.textContent);

  if (!headline || !Number.isFinite(recent48)) return;

  if (recent48 > 0 && headline.textContent?.trim() === "Weakening") {
    headline.textContent = "Positive, but slowing";
    headline.classList.remove("negative");
    headline.classList.add("slowing");
    if (narrative) {
      narrative.textContent = "Recent results remain profitable, but the pace is slower than the previous 48-hour period.";
    }
    return;
  }

  headline.classList.remove("slowing");
}

export default function AnalyticsToneFix() {
  useEffect(() => {
    applyAnalyticsTone();

    const observer = new MutationObserver(() => applyAnalyticsTone());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const timer = window.setInterval(applyAnalyticsTone, 1000);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
