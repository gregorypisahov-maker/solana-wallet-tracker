import fs from "node:fs";

const file = "app/storefront/page.tsx";
let source = fs.readFileSync(file, "utf8");

const replacements = [
  ['  id: "legion" | "shadow" | "tiered";', '  id: "legion" | "shadow";'],
  [`  tiered: {
    title: "Tiered",
    subtitle: "Confirmed first-buy tracking",
    icon: "↗",
    description:
      "Follows the earliest qualifying buy from proven wallets, then demands a second price and liquidity read before entering.",
    protections: ["Wallet trust 65+", "Eight-second market confirmation", "Atomic position accounting"],
  },
`, ""],
  [
    '    const [paperResult, shadowResult, tieredResult, walletCountResult, decisionCountResult, decisionResult, readinessResult] =',
    '    const [paperResult, shadowResult, walletCountResult, decisionCountResult, decisionResult, readinessResult] ='
  ],
  ['        supabase.from("tiered_trades").select("id,position_id,pnl_sol,happened_at").limit(3000),\n', ''],
  ['      aggregateStrategy("tiered", "Tiered", (tieredResult.data ?? []) as TradeRow[]),\n', ''],
  ['        { id: "tiered", name: "Tiered", pnl: 0, positions: 0, winRate: 0, profitFactor: null },\n', ''],
  ['    { value: "3", label: "Active strategy engines" },', '    { value: "2", label: "Active Solana strategy engines" },'],
  ['protections: ["Wallet trust 65+", "Eight-second market confirmation", "Atomic position accounting"],',
   'protections: ["Proven-wallet qualification", "Secondary market confirmation", "Atomic position accounting"],'],
  ['trust_below_55: "Trust below 55",', 'trust_below_55: "Wallet quality threshold failed",'],
  ['two_wallet_elite_gate_failed: "Elite two-wallet gate failed",', 'two_wallet_elite_gate_failed: "Elite consensus standard not met",'],
  ['wallet_count_below_3: "Insufficient wallet consensus",', 'wallet_count_below_3: "Insufficient wallet consensus",'],
  ['score_above_65: "Late-entry guard",', 'score_above_65: "Late-entry guard triggered",'],
  ['score_below_10: "Signal score too low",', 'score_below_10: "Signal-quality threshold failed",'],
  ['mcap_above_200k: "Market cap above $200K",', 'mcap_above_200k: "Market structure outside strategy range",'],
  ['mcap_below_20k: "Market cap below $20K",', 'mcap_below_20k: "Market structure outside strategy range",'],
  ['liquidity_below_15k: "Liquidity below $15K",', 'liquidity_below_15k: "Liquidity threshold failed",'],
  ['liq_ratio_below_15pct: "Liquidity ratio below 15%",', 'liq_ratio_below_15pct: "Liquidity structure threshold failed",'],
  ['  return labels[clean] ?? clean.replaceAll("_", " ");', `  if (labels[clean]) return labels[clean];
  if (clean.startsWith("avg_buy_below")) return "Wallet commitment threshold failed";
  if (clean.startsWith("missing_wallet_trust") || clean.startsWith("missing_trust")) return "Wallet quality evidence unavailable";
  if (clean.includes("liquidity")) return "Liquidity quality threshold failed";
  if (clean.includes("mcap") || clean.includes("market_cap")) return "Market structure threshold failed";
  if (clean.includes("score")) return "Signal-quality threshold failed";
  return "Risk control rejected candidate";`],
  ['<span>Solana Intelligence · Paper-trading research platform · Updated {israelTime(data.generatedAt)} Israel time</span>',
   '<span>© 2026 Solana Intelligence · Proprietary paper-research platform · Updated {israelTime(data.generatedAt)} Israel time</span>'],
  ['<div className="sfFooterLinks"><a href="#strategies">Strategies</a><a href="#validation">Validation</a><Link href="/platform">Private platform</Link></div>',
   '<div className="sfFooterLinks"><a href="#strategies">Strategies</a><a href="#validation">Validation</a><Link href="/terms">Terms</Link><Link href="/platform">Private platform</Link></div>'],
];

for (const [before, after] of replacements) {
  source = source.replace(before, after);
}

fs.writeFileSync(file, source);
console.log("[build] Sanitized public strategy disclosures and removed Tiered presentation.");
