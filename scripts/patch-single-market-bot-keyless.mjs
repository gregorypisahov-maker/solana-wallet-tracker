import fs from "node:fs";

const files = [
  "single-bot/marketBot.ts",
  "single-bot/marketExecutor.ts",
];

for (const file of files) {
  let source = fs.readFileSync(file, "utf8");
  const before = source;

  source = source.replace(
    'const JUPITER_API_KEY = required("JUPITER_API_KEY");',
    'const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || null;'
  );

  if (file.endsWith("marketBot.ts")) {
    source = source.replace(
      'headers: { accept: "application/json", "x-api-key": JUPITER_API_KEY },',
      'headers: { accept: "application/json", ...(JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}) },'
    );
  } else {
    source = source.replace(
      '"x-api-key": JUPITER_API_KEY,\n      ...(init?.headers ?? {}),',
      '...(JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}),\n      ...(init?.headers ?? {}),'
    );
  }

  if (source !== before) {
    fs.writeFileSync(file, source);
    console.log(`[patch-single-market-bot-keyless] patched ${file}`);
  } else if (source.includes('process.env.JUPITER_API_KEY?.trim() || null')) {
    console.log(`[patch-single-market-bot-keyless] already applied ${file}`);
  } else {
    throw new Error(`[patch-single-market-bot-keyless] expected anchors missing in ${file}`);
  }
}
