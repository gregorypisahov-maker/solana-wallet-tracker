import fs from "node:fs";

const pagePath = "app/page.tsx";
let page = fs.readFileSync(pagePath, "utf8");

const cssImport = 'import "./platform-v2.css";';
const labImport = 'import WalletLab from "./WalletLab";';
if (!page.includes(labImport)) {
  if (!page.includes(cssImport)) throw new Error("Wallet Lab dashboard patch: CSS import anchor not found");
  page = page.replace(cssImport, `${cssImport}\n${labImport}`);
}

page = page.replace(
  'type View = "overview" | "bots" | "trades" | "analytics";',
  'type View = "overview" | "bots" | "trades" | "analytics" | "lab";'
);
page = page.replace(
  'const views: View[] = ["overview", "bots", "trades", "analytics"];',
  'const views: View[] = ["overview", "bots", "trades", "analytics", "lab"];'
);

const iconBefore = 'item === "overview" ? "⌂" : item === "bots" ? "◈" : item === "trades" ? "⇄" : "⌁"';
const iconAfter = 'item === "overview" ? "⌂" : item === "bots" ? "◈" : item === "trades" ? "⇄" : item === "analytics" ? "⌁" : "◎"';
page = page.split(iconBefore).join(iconAfter);

const analyticsRender = '{view === "analytics" && <Analytics data={data} />}';
const labRender = `${analyticsRender}\n        {view === "lab" && <WalletLab />}`;
if (!page.includes('{view === "lab" && <WalletLab />}')) {
  if (!page.includes(analyticsRender)) throw new Error("Wallet Lab dashboard patch: analytics render anchor not found");
  page = page.replace(analyticsRender, labRender);
}

fs.writeFileSync(pagePath, page);

const cssPath = "app/platform-v2.css";
let css = fs.readFileSync(cssPath, "utf8");
const marker = "/* wallet-lab-v1 */";
if (!css.includes(marker)) {
  css += `\n${marker}\n.v2LabImport{padding:18px}.v2LabImport form{display:grid;gap:12px;margin-top:15px}.v2LabImport textarea{min-height:112px;resize:vertical;border:1px solid var(--line);border-radius:11px;background:#0d1319;color:white;padding:12px;line-height:1.45}.v2LabImportControls{display:grid;grid-template-columns:180px 180px auto;gap:10px;align-items:end}.v2LabImportControls label span{display:block;color:var(--muted);font-size:9px;margin-bottom:5px}.v2LabImportControls select{width:100%;border:1px solid var(--line);border-radius:9px;background:#0d1319;color:white;padding:9px}.v2LabImportControls button,.v2LabActions button{border:1px solid var(--line);border-radius:9px;background:#19232e;color:#dfe7f0;padding:9px 11px;cursor:pointer}.v2LabImportControls button:disabled,.v2LabActions button:disabled{opacity:.55;cursor:wait}.v2LabRanking{display:grid;gap:9px;padding:16px}.v2LabRank{display:grid;grid-template-columns:34px 86px minmax(190px,1fr) minmax(330px,1.35fr) auto;gap:13px;align-items:center;border:1px solid var(--line);border-radius:13px;padding:12px;background:#0d141c}.v2LabRankNo{color:var(--muted);font-size:12px;font-weight:800}.v2Quality{width:76px;height:62px;border:1px solid var(--line);border-radius:12px;display:grid;place-items:center;align-content:center;background:#101922}.v2Quality strong{font-size:20px}.v2Quality span{font-size:7px;color:var(--muted);margin-top:2px}.v2Quality.excellent,.excellent{color:var(--green)}.v2Quality.good,.good{color:#8edb8e}.v2Quality.watch,.watch{color:var(--amber)}.v2Quality.poor,.poor{color:var(--red)}.v2Quality.pending,.pending{color:var(--muted)}.v2LabIdentity{min-width:0}.v2LabIdentity strong{display:block;font-size:11px}.v2LabIdentity code,.v2LabTable code{display:block;overflow:hidden;text-overflow:ellipsis;color:#7f8d9d;font-size:8px;margin-top:4px}.v2LabIdentity small{display:block;color:var(--muted);font-size:8px;margin-top:4px}.v2LabRank dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:0}.v2LabRank dl div{border-left:1px solid var(--line);padding-left:8px}.v2LabRank dt{color:var(--muted);font-size:7px}.v2LabRank dd{margin:3px 0 0;font-size:9px;font-weight:750}.v2LabActions{display:flex;gap:6px;flex-wrap:wrap}.v2LabActions button{padding:7px 9px;font-size:8px}.v2LabActions button.primary{background:rgba(69,212,131,.12);border-color:rgba(69,212,131,.24);color:var(--green)}.v2LabActions button.danger{background:rgba(255,111,127,.1);border-color:rgba(255,111,127,.22);color:var(--red)}.v2LabEmpty{padding:28px 16px;color:var(--muted);font-size:10px}.v2LabTable{overflow-x:auto}.v2LabTable .head,.v2LabTable .row{display:grid;grid-template-columns:minmax(170px,1.2fr) minmax(100px,.65fr) 90px minmax(180px,1fr) minmax(180px,1fr) 150px;gap:10px;align-items:center;padding:11px 14px;min-width:930px}.v2LabTable .head{border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:8px;text-transform:uppercase}.v2LabTable .row{border-bottom:1px solid rgba(34,44,56,.7);font-size:9px}.v2LabTable .row:last-child{border-bottom:0}.v2LabTable b{display:block;font-size:9px}.v2LabTable small{display:block;color:var(--muted);font-size:7px;margin-top:3px;overflow:hidden;text-overflow:ellipsis}.v2LabFormula{display:flex;justify-content:space-between;gap:20px;padding:15px 17px}.v2LabFormula strong{font-size:11px}.v2LabFormula p,.v2LabFormula small{color:var(--muted);font-size:9px;line-height:1.45}.v2LabFormula p{margin:4px 0 0}.v2LabFormula small{max-width:470px}@media(max-width:1050px){.v2LabRank{grid-template-columns:30px 80px minmax(160px,1fr) minmax(280px,1.2fr)}.v2LabRank>.v2LabActions{grid-column:3/-1}.v2LabImportControls{grid-template-columns:1fr 1fr}}@media(max-width:760px){.v2LabImportControls{grid-template-columns:1fr}.v2LabRank{grid-template-columns:28px 72px 1fr;gap:9px}.v2LabRank dl{grid-column:1/-1;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);padding-top:10px}.v2LabRank>.v2LabActions{grid-column:1/-1}.v2LabFormula{display:grid}.v2LabFormula small{max-width:none}}\n`;
  fs.writeFileSync(cssPath, css);
}

console.log("[patch] Wallet Lab dashboard tab and styles applied");
