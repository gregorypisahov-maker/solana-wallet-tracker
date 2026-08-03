import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[v3-mobile-dashboard] missing ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  "table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}tbody,thead{display:table;width:100%;table-layout:fixed}td,th{padding:8px;border-bottom:1px solid #26384d;text-align:left;font-size:12px;white-space:nowrap}",
  ".table-scroll{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:10px}table{width:100%;min-width:820px;border-collapse:collapse;table-layout:auto}thead{display:table-header-group}tbody{display:table-row-group}tr{display:table-row}td,th{display:table-cell;padding:9px 10px;border-bottom:1px solid #26384d;text-align:left;font-size:12px;white-space:nowrap}th:nth-child(1),td:nth-child(1){min-width:150px}th:nth-child(2),td:nth-child(2){min-width:90px}th:nth-child(3),td:nth-child(3){min-width:110px}th:nth-child(7),td:nth-child(7){min-width:130px}@media(max-width:600px){body{padding:10px}.card{padding:12px}.table-scroll{margin:0 -4px;padding-bottom:5px}h2{font-size:22px}}",
  "responsive table CSS",
);

replaceOnce(
  "'<div class=\"card\"><h2>Top market candidates</h2><table>",
  "'<div class=\"card\"><h2>Top market candidates</h2><div class=\"small muted\">Swipe sideways to view all columns →</div><div class=\"table-scroll\"><table>",
  "candidate table wrapper",
);

replaceOnce(
  "</tbody></table></div>'+\n'<div class=\"card\"><h2>Recent trades</h2><table>",
  "</tbody></table></div></div>'+\n'<div class=\"card\"><h2>Recent trades</h2><div class=\"small muted\">Swipe sideways to view all columns →</div><div class=\"table-scroll\"><table>",
  "trade table opening wrapper",
);

replaceOnce(
  "</tbody></table></div>'; }catch(e)",
  "</tbody></table></div></div>'; }catch(e)",
  "trade table closing wrapper",
);

replaceOnce(
  "new Date(t.created_at).toLocaleString()",
  "new Date(t.created_at).toLocaleString(undefined,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})",
  "compact trade timestamp",
);

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-v3-mobile-dashboard] applied");
