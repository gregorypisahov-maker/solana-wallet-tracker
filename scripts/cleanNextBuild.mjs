import { rmSync } from 'node:fs';

rmSync('.next', { recursive: true, force: true });
console.log('[build] Removed cached .next output before production build.');
