import fs from "node:fs";

const file = "single-bot/server.ts";
let source = fs.readFileSync(file, "utf8");

const marker = `app.post(WEBHOOK_PATH, (req: Request, res: Response) => {`;
const helper = `function explainIgnoredTransaction(tx: HeliusEnhancedTransaction): string {
  if (!tx || typeof tx !== "object") return "Ignored: invalid webhook payload";
  if (!tx.signature) return "Ignored: transaction signature missing";
  if (tx.transactionError) return "Ignored: on-chain transaction failed";
  if (tx.type !== "SWAP") return \`Ignored: transaction type is \${tx.type ?? "unknown"}, not SWAP\`;
  if (!tx.events?.swap) return "Ignored: Helius SWAP event details missing";

  const inputMints = unique((tx.events.swap.tokenInputs ?? []).map((item) => item.mint));
  const outputMints = unique((tx.events.swap.tokenOutputs ?? []).map((item) => item.mint));
  if (inputMints.length === 0 && outputMints.length === 0) {
    return "Ignored: no SPL token mints found in swap event";
  }

  const targetMint = selectTargetMint(inputMints, outputMints);
  if (!targetMint) {
    const pair = [...inputMints, ...outputMints]
      .map((mint) => mint === USDC_MINT ? "USDC" : mint === WSOL_MINT ? "SOL" : mint)
      .join(" → ");
    return \`Ignored: no target token; base-asset-only swap (\${pair || "USDC/SOL"})\`;
  }

  return "Ignored: swap payload did not satisfy parser requirements";
}

${marker}`;

if (!source.includes("function explainIgnoredTransaction")) {
  if (!source.includes(marker)) throw new Error("single bot app.post anchor not found");
  source = source.replace(marker, helper);
}

const oldBlock = `    const signal = parseSwap(tx);
    if (!signal) {
      ignored += 1;
      state.ignoredCount += 1;
      continue;
    }`;

const newBlock = `    const signal = parseSwap(tx);
    if (!signal) {
      ignored += 1;
      state.ignoredCount += 1;
      const message = explainIgnoredTransaction(tx);
      addActivity({
        at: new Date().toISOString(),
        signature: tx.signature,
        status: "ignored",
        message,
      });
      console.warn(\`[single-bot] \${message} signature=\${tx.signature}\`);
      continue;
    }`;

if (!source.includes(newBlock)) {
  if (!source.includes(oldBlock)) throw new Error("single bot ignored-block anchor not found");
  source = source.replace(oldBlock, newBlock);
}

fs.writeFileSync(file, source);
console.log("[patch-single-bot-ignore-reasons] applied");
