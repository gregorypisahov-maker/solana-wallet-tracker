import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const parts = [
  resolve("assets/audio/background-music-6s.part-00"),
  resolve("assets/audio/background-music-6s.part-01"),
  resolve("assets/audio/background-music-6s.part-02"),
];
const output = resolve("public/audio/background-music.mp3");

for (const part of parts) {
  if (!existsSync(part)) {
    console.warn(`[build] Background-music part missing: ${part}`);
    process.exit(0);
  }
}

mkdirSync(dirname(output), { recursive: true });
const audio = Buffer.concat(parts.map((part) => readFileSync(part)));
writeFileSync(output, audio);
console.log(`[build] Prepared background music (${audio.length} bytes).`);
