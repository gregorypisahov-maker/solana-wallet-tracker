import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

const recentAnchor = "const recentMints = new Map<string, number>();";
const programConstant = 'const CLASSIC_SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";';
if (!source.includes(programConstant)) {
  if (!source.includes(recentAnchor)) throw new Error("[classic-spl-only] recent mint anchor missing");
  source = source.replace(recentAnchor, `${programConstant}\n${recentAnchor}`);
}

const auditAnchor = "  const audit = token?.audit ?? {};";
const gate = `${auditAnchor}
  const tokenProgram = String(token?.tokenProgram ?? "");
  const tokenTags = Array.isArray(token?.tags) ? token.tags.map((tag: unknown) => String(tag).toLowerCase()) : [];
  if ((tokenProgram && tokenProgram !== CLASSIC_SPL_TOKEN_PROGRAM) || tokenTags.includes("token-2022")) return null;`;
if (!source.includes("tokenTags.includes(\"token-2022\")")) {
  if (!source.includes(auditAnchor)) throw new Error("[classic-spl-only] audit anchor missing");
  source = source.replace(auditAnchor, gate);
}

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-classic-spl-only] applied");
