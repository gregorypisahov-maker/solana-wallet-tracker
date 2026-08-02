import fs from "node:fs";

function patchMarketBot() {
  const path = "single-bot/marketBot.ts";
  let source = fs.readFileSync(path, "utf8");
  const importLine = 'import { jupiterFetchJson } from "./jupiterRateLimit";';
  if (!source.includes(importLine)) {
    source = source.replace(
      'import express, { type Request, type Response } from "express";',
      'import express, { type Request, type Response } from "express";\n' + importLine
    );
  }

  const oldJup = `async function jup(path: string): Promise<any> {
  const response = await fetch(\`https://api.jup.ag\${path}\`, {
    headers: { accept: "application/json", ...(JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}) },
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(\`jupiter_market_http_\${response.status}: \${text.slice(0, 400)}\`);
  return text ? JSON.parse(text) : null;
}`;
  const newJup = `async function jup(path: string): Promise<any> {
  return jupiterFetchJson(\`https://api.jup.ag\${path}\`);
}`;
  if (source.includes(oldJup)) source = source.replace(oldJup, newJup);
  else if (!source.includes(newJup)) throw new Error("marketBot jup anchor not found");

  const oldPriceSuccess = `    const price = await tokenPrice(position.mint);
    if (price > position.highWaterPriceUsd) {`;
  const newPriceSuccess = `    const price = await tokenPrice(position.mint);
    if (state.last_error) await patchState({ last_error: null });
    if (price > position.highWaterPriceUsd) {`;
  if (source.includes(oldPriceSuccess)) source = source.replace(oldPriceSuccess, newPriceSuccess);

  fs.writeFileSync(path, source);
  console.log("[patch-single-market-bot-rate-limit] patched marketBot.ts");
}

function patchMarketExecutor() {
  const path = "single-bot/marketExecutor.ts";
  let source = fs.readFileSync(path, "utf8");
  const importLine = 'import { jupiterFetchJson } from "./jupiterRateLimit";';
  if (!source.includes(importLine)) {
    source = source.replace(
      'import bs58 from "bs58";',
      'import bs58 from "bs58";\n' + importLine
    );
  }

  const start = source.indexOf("async function jupiterFetch(path: string, init?: RequestInit): Promise<any> {");
  const endMarker = "\n}\n\nexport function getWalletPublicKey";
  const end = source.indexOf(endMarker, start);
  if (start >= 0 && end >= 0) {
    const replacement = `async function jupiterFetch(path: string, init?: RequestInit): Promise<any> {
  return jupiterFetchJson(\`\${JUPITER_BASE}\${path}\`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}`;
    source = source.slice(0, start) + replacement + source.slice(end + 2);
  } else if (!source.includes("return jupiterFetchJson(`${JUPITER_BASE}${path}`")) {
    throw new Error("marketExecutor jupiterFetch anchor not found");
  }

  fs.writeFileSync(path, source);
  console.log("[patch-single-market-bot-rate-limit] patched marketExecutor.ts");
}

patchMarketBot();
patchMarketExecutor();
