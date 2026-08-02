import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");
const original = source;

source = source.replace(
  'import { getSupabaseAdmin } from "../lib/supabase";',
  'import { getMarketStore } from "./marketStore";'
);
source = source.replace(
  'const supabase = getSupabaseAdmin();',
  'const supabase = getMarketStore();'
);

if (source !== original) {
  fs.writeFileSync(path, source);
  console.log("[patch-single-market-bot-store] applied");
} else if (source.includes('import { getMarketStore } from "./marketStore";') && source.includes('const supabase = getMarketStore();')) {
  console.log("[patch-single-market-bot-store] already applied");
} else {
  throw new Error("[patch-single-market-bot-store] expected anchors missing");
}
