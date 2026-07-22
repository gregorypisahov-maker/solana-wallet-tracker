import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const parts = [
  resolve("assets/audio/background-loop.part-00"),
  resolve("assets/audio/background-loop.part-01"),
];
const output = resolve("public/audio/background-music.mp3");

for (const part of parts) {
  if (!existsSync(part)) {
    console.warn(`[build] Background-music part missing: ${part}`);
    process.exit(0);
  }
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat(parts.map((part) => readFileSync(part))));
console.log(`[build] Prepared background music (${readFileSync(output).length} bytes).`);
