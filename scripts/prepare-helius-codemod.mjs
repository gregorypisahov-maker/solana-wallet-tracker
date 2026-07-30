import fs from "node:fs";

const path = "scripts/codemod-helius-price-discovery-cache.mjs";
let source = fs.readFileSync(path, "utf8");
const before = '    if (!source.includes(before)) throw new Error(`${path}: missing pattern ${label}`);';
const after = '    if (!source.includes(before)) {\n      if (label === "gecko token log") continue;\n      throw new Error(`${path}: missing pattern ${label}`);\n    }';
if (!source.includes(before)) throw new Error("codemod guard pattern missing");
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log("Optional Gecko log replacement made non-blocking.");
