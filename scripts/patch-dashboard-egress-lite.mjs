import fs from "node:fs";

function replace(path, from, to) {
  let text = fs.readFileSync(path, "utf8");
  if (!text.includes(from)) {
    console.warn(`[patch-dashboard-egress-lite] pattern missing in ${path}: ${from.slice(0, 100)}`);
    return;
  }
  text = text.replace(from, to);
  fs.writeFileSync(path, text);
}

const route = "app/api/compact-dashboard/route.ts";
replace(route,
  'supabase.from("paper_trades").select("*").order("happened_at", { ascending: false }).limit(1000)',
  'supabase.from("paper_trades").select("id,position_id,token_symbol,mint,type,reason,entry_price,exit_price,multiple,sold_pct,sold_size_sol,proceeds_sol,pnl_sol,hold_minutes,happened_at").order("happened_at", { ascending: false }).limit(300)'
);
replace(route,
  'supabase.from("shadow_trades").select("*").order("happened_at", { ascending: false }).limit(500)',
  'supabase.from("shadow_trades").select("*").order("happened_at", { ascending: false }).limit(100)'
);
replace(route,
  'supabase.from("scalp_trades").select("*").order("closed_at", { ascending: false }).limit(500)',
  'supabase.from("scalp_trades").select("id,position_id,token_symbol,mint,pair_address,entry_price_usd,exit_price_usd,exit_reason,pnl_sol,closed_at").order("closed_at", { ascending: false }).limit(200)'
);
replace(route,
  'supabase.from("scalp_scan_runs").select("*").order("started_at", { ascending: false }).limit(20)',
  'supabase.from("scalp_scan_runs").select("id,started_at,finished_at,status,scanned_count,qualified_count,top_symbol,top_mint,top_score,selected_mint,message").order("started_at", { ascending: false }).limit(10)'
);
replace(route,
  'supabase.from("ai_discovery_trades").select("*").order("closed_at", { ascending: false }).limit(500)',
  'supabase.from("ai_discovery_trades").select("id,position_id,token_symbol,mint,pair_address,entry_price_usd,exit_price_usd,exit_reason,pnl_sol,closed_at").order("closed_at", { ascending: false }).limit(200)'
);
replace(route,
  'supabase.from("market_opportunities").select("*").order("score", { ascending: false }).limit(25)',
  'supabase.from("market_opportunities").select("mint,token_symbol,pair_address,score,confidence,status,market_regime,liquidity_usd,market_cap_usd,price_usd,price_change_m5,price_change_h1,volume_m5_usd,buys_m5,sells_m5,buyers_m5,pool_age_minutes,reasons,risks,last_seen_at").order("score", { ascending: false }).limit(15)'
);
replace(route,
  'supabase.from("market_discovery_runs").select("*").order("started_at", { ascending: false }).limit(20)',
  'supabase.from("market_discovery_runs").select("id,started_at,finished_at,status,scanned_count,ranked_count,top_symbol,top_mint,top_score,market_regime,message").order("started_at", { ascending: false }).limit(10)'
);

replace("app/page.tsx",
  'const a = setInterval(() => void refresh(), 10_000);',
  'const a = setInterval(() => void refresh(), 30_000);'
);

console.log("[patch-dashboard-egress-lite] applied");