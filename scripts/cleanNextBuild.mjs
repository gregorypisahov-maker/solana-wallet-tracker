import { rmSync } from 'node:fs';

if (process.env.VERCEL) {
  rmSync('.next', { recursive: true, force: true });
  console.log('[build] Removed cached .next output before the Vercel build.');
} else {
  console.log('[build] Skipped Vercel-only .next cleanup.');
}
