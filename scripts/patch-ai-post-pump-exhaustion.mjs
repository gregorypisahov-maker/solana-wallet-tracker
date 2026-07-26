import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  let changed = false;
  for (const { from, to, marker } of replacements) {
    if (marker && text.includes(marker)) continue;
    if (!text.includes(from)) {
      console.warn(`[patch-ai-post-pump-exhaustion] pattern missing in ${path}: ${String(from).slice(0, 120)}`);
      continue;
    }
    text = text.replace(from, to);
    changed = true;
  }
  if (changed) fs.writeFileSync(path, text);
}

patch("paper-trader/marketDiscoveryAgent.ts", [
  {
    from: "  changeH1: number;\n  volumeM5: number;",
    to: "  changeH1: number;\n  changeH24: number;\n  volumeM5: number;",
    marker: "changeH24: number;",
  },
  {
    from: "    changeH1: num(a.price_change_percentage?.h1, NaN),\n    volumeM5: num(a.volume_usd?.m5, NaN),",
    to: "    changeH1: num(a.price_change_percentage?.h1, NaN),\n    changeH24: num(a.price_change_percentage?.h24, 0),\n    volumeM5: num(a.volume_usd?.m5, NaN),",
    marker: "changeH24: num(a.price_change_percentage?.h24",
  },
  {
    from: "  if (c.changeH1 >= 5 && c.changeH1 <= 60) { score += 8; reasons.push(\"one_hour_confirmation\"); }\n  else if (c.changeH1 > 100) { score -= 8; risks.push(\"late_entry_risk\"); }",
    to: "  if (c.changeH1 >= 5 && c.changeH1 <= 60) { score += 8; reasons.push(\"one_hour_confirmation\"); }\n  else if (c.changeH1 > 100) { score -= 8; risks.push(\"late_entry_risk\"); }\n\n  // A huge older pump followed by weak recent momentum is usually a post-crash bounce, not fresh discovery momentum.\n  const postPumpExhaustion = c.changeH24 >= 250 && (c.changeH1 <= 20 || c.changeM5 <= 2);\n  if (postPumpExhaustion) { score -= 30; risks.push(\"post_pump_exhaustion\"); }",
    marker: "post_pump_exhaustion",
  },
  {
    from: "signal_snapshot: { version: VERSION, buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5), timing:",
    to: "signal_snapshot: { version: VERSION, buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5), priceChangeH24: item.changeH24, postPumpExhaustion: item.risks.includes(\"post_pump_exhaustion\"), timing:",
    marker: "postPumpExhaustion: item.risks.includes",
  },
]);

patch("paper-trader/aiDiscoveryTrader.ts", [
  {
    from: "function ruleAssessment(opportunity: any): { passed: boolean; reasons: string[] } { const reasons: string[] = []; if (opportunity.status !== \"armed\") reasons.push(\"not_armed\"); if (n(opportunity.score) < MIN_SCORE) reasons.push(\"score_below_minimum\"); if ((opportunity.risks ?? []).length > 1) reasons.push(\"too_many_risks\"); if (!opportunity.pair_address) reasons.push(\"missing_pair\"); return { passed: reasons.length === 0, reasons }; }",
    to: "function ruleAssessment(opportunity: any): { passed: boolean; reasons: string[] } { const reasons: string[] = []; const risks = Array.isArray(opportunity.risks) ? opportunity.risks : []; const hardVetoRisks = [\"post_pump_exhaustion\", \"vertical_price_spike\", \"late_entry_risk\"]; if (opportunity.status !== \"armed\") reasons.push(\"not_armed\"); if (n(opportunity.score) < MIN_SCORE) reasons.push(\"score_below_minimum\"); if (risks.length > 1) reasons.push(\"too_many_risks\"); for (const risk of hardVetoRisks) if (risks.includes(risk)) reasons.push(`hard_veto_${risk}`); if (!opportunity.pair_address) reasons.push(\"missing_pair\"); return { passed: reasons.length === 0, reasons }; }",
    marker: "hard_veto_${risk}",
  },
]);

console.log("[patch-ai-post-pump-exhaustion] enabled hard veto for exhausted post-pump bounces, vertical spikes, and late-entry risk");
