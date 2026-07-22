import fs from "node:fs";

const routeFile = "app/api/wallet-lab/route.ts";
const uiFile = "app/WalletLab.tsx";

let route = fs.readFileSync(routeFile, "utf8");
let ui = fs.readFileSync(uiFile, "utf8");

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Wallet Lab qualification patch target missing: ${label}`);
  return source.replace(before, after);
}

route = replaceOnce(
  route,
  `      top10: ranked.slice(0, 10),`,
  `      top10: ranked.filter((row) => row.profile?.qualifies_for_trial === true).slice(0, 10),`,
  "qualified Top 10"
);

route = replaceOnce(
  route,
  `    const labByAddress = new Map((labRows ?? []).map((row: any) => [row.wallet_address, row]));\n\n    const walletRows = addresses.map((address, index) => {`,
  `    const labByAddress = new Map((labRows ?? []).map((row: any) => [row.wallet_address, row]));\n    const unqualified = addresses.filter((address) => {\n      const lab = labByAddress.get(address) as any;\n      return lab?.final_profile?.qualifies_for_trial !== true;\n    });\n    if (unqualified.length > 0) {\n      return NextResponse.json(\n        { error: \`Only Lab-qualified wallets can be activated. Blocked: \${unqualified.join(", ")}\` },\n        { status: 400 }\n      );\n    }\n\n    const walletRows = addresses.map((address, index) => {`,
  "activation qualification guard"
);

ui = replaceOnce(
  ui,
  `  async function toggle(candidate: Candidate) {\n    await action(\n      {\n        action: candidate.active ? "deactivate" : "activate",\n        addresses: [candidate.address],\n        label: candidate.label ?? \`${"${candidate.platform}"} Lab ${"${short(candidate.address)}"}\`,\n      },\n      candidate.active ? "Wallet deactivated from live monitoring." : "Wallet activated as a live trial."\n    );\n  }\n\n  return (`,
  `  async function toggle(candidate: Candidate) {\n    if (!candidate.active && candidate.profile?.qualifies_for_trial !== true) {\n      setNotice("This wallet has not passed the Lab qualification rules and cannot be activated.");\n      return;\n    }\n    await action(\n      {\n        action: candidate.active ? "deactivate" : "activate",\n        addresses: [candidate.address],\n        label: candidate.label ?? \`${"${candidate.platform}"} Lab ${"${short(candidate.address)}"}\`,\n      },\n      candidate.active ? "Wallet deactivated from live monitoring." : "Wallet activated as a live trial."\n    );\n  }\n\n  async function activateQualified() {\n    const qualified = (data?.candidates ?? []).filter(\n      (candidate) => candidate.profile?.qualifies_for_trial === true && !candidate.active\n    );\n    if (qualified.length === 0) {\n      setNotice("There are no inactive qualified wallets to activate.");\n      return;\n    }\n    await action(\n      { action: "activate", addresses: qualified.map((candidate) => candidate.address) },\n      \`${"${qualified.length}"} qualified wallet${"${qualified.length === 1 ? \"\" : \"s\"}"} activated for live monitoring.\`\n    );\n  }\n\n  return (`,
  "qualified activation functions"
);

ui = replaceOnce(
  ui,
  `            <button type="button" onClick={() => void scan()} disabled={busy}>Scan all Lab wallets</button>`,
  `            <button type="button" onClick={() => void scan()} disabled={busy}>Scan all Lab wallets</button>\n            <button type="button" onClick={() => void activateQualified()} disabled={busy}>Activate all qualified</button>`,
  "activate all qualified button"
);

ui = replaceOnce(
  ui,
  `<div className="v2LabActions"><button type="button" disabled={busy} onClick={() => void scan(candidate)}>Rescan</button><button type="button" className={candidate.active ? "danger" : "primary"} disabled={busy} onClick={() => void toggle(candidate)}>{candidate.active ? "Deactivate" : "Activate trial"}</button></div>`,
  `<div className="v2LabActions"><button type="button" disabled={busy} onClick={() => void scan(candidate)}>Rescan</button><button type="button" className={candidate.active ? "danger" : "primary"} disabled={busy || (!candidate.active && candidate.profile?.qualifies_for_trial !== true)} onClick={() => void toggle(candidate)}>{candidate.active ? "Deactivate" : candidate.profile?.qualifies_for_trial === true ? "Activate trial" : "Not qualified"}</button></div>`,
  "Top 10 activation button"
);

ui = replaceOnce(
  ui,
  `<div className="v2LabActions"><button type="button" disabled={busy} onClick={() => void scan(candidate)}>Scan</button><button type="button" className={candidate.active ? "danger" : "primary"} disabled={busy} onClick={() => void toggle(candidate)}>{candidate.active ? "Pause" : "Activate"}</button></div>`,
  `<div className="v2LabActions"><button type="button" disabled={busy} onClick={() => void scan(candidate)}>Scan</button><button type="button" className={candidate.active ? "danger" : "primary"} disabled={busy || (!candidate.active && candidate.profile?.qualifies_for_trial !== true)} onClick={() => void toggle(candidate)}>{candidate.active ? "Pause" : candidate.profile?.qualifies_for_trial === true ? "Activate" : "Not qualified"}</button></div>`,
  "all-wallet activation button"
);

fs.writeFileSync(routeFile, route);
fs.writeFileSync(uiFile, ui);
console.log("[build] Wallet Lab activation restricted to qualified wallets.");
