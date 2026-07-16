import fs from 'node:fs';

const path = 'paper-trader/engine.ts';
const source = fs.readFileSync(path, 'utf8');
const marker = 'const TRAILING_ACTIVATION_MULTIPLE = 1.20;';

if (source.includes(marker)) {
  console.log('[profit-protection] already installed');
  process.exit(0);
}

const anchor = 'async function processOpenPositions(): Promise<void> {';
const constants = `const BREAK_EVEN_ACTIVATION_MULTIPLE = 1.10;\nconst TRAILING_ACTIVATION_MULTIPLE = 1.20;\nconst BREAK_EVEN_FLOOR_MULTIPLE = 1.001;\n\n`;

if (!source.includes(anchor)) {
  console.warn('[profit-protection] engine anchor not found; leaving source unchanged');
  process.exit(0);
}

let updated = source.replace(anchor, constants + anchor);

const oldBlock = `    if (\n      currentMultiple <=\n      1 - config.exit.hardStopLossPct\n    ) {\n      await closePosition(\n        position,\n        currentPrice,\n        position.remainingPct,\n        "hard_stop_loss",\n        state\n      );\n\n      continue;\n    }`;

const newBlock = `    // Once a position has reached +10%, never allow the normal hard stop\n    // to turn it into a meaningful loss. A tiny 0.1% cushion covers rounding.\n    const breakEvenArmed =\n      position.peakMultiple >= BREAK_EVEN_ACTIVATION_MULTIPLE;\n\n    if (breakEvenArmed && currentMultiple <= BREAK_EVEN_FLOOR_MULTIPLE) {\n      await closePosition(\n        position,\n        currentPrice,\n        position.remainingPct,\n        "break_even_stop",\n        state\n      );\n\n      continue;\n    }\n\n    if (\n      !breakEvenArmed &&\n      currentMultiple <= 1 - config.exit.hardStopLossPct\n    ) {\n      await closePosition(\n        position,\n        currentPrice,\n        position.remainingPct,\n        "hard_stop_loss",\n        state\n      );\n\n      continue;\n    }`;

if (!updated.includes(oldBlock)) {
  console.warn('[profit-protection] hard-stop block not found; leaving source unchanged');
  process.exit(0);
}
updated = updated.replace(oldBlock, newBlock);

const oldTrailing = `    if (position.peakMultiple > 1) {\n      const trailingFloor =\n        position.peakMultiple *\n        (1 - config.exit.trailingStopPct);\n\n      if (currentMultiple <= trailingFloor) {\n        await closePosition(\n          position,\n          currentPrice,\n          position.remainingPct,\n          "trailing_stop",\n          state\n        );\n\n        continue;\n      }\n    }`;

const newTrailing = `    // Trailing protection activates only after a genuine +20% move.\n    // Its floor can never fall below break-even, so a trade labelled\n    // trailing_stop cannot close as a meaningful loss anymore.\n    if (position.peakMultiple >= TRAILING_ACTIVATION_MULTIPLE) {\n      const trailingFloor = Math.max(\n        BREAK_EVEN_FLOOR_MULTIPLE,\n        position.peakMultiple * (1 - config.exit.trailingStopPct)\n      );\n\n      if (currentMultiple <= trailingFloor) {\n        await closePosition(\n          position,\n          currentPrice,\n          position.remainingPct,\n          "trailing_stop",\n          state\n        );\n\n        continue;\n      }\n    }`;

if (!updated.includes(oldTrailing)) {
  console.warn('[profit-protection] trailing block not found; leaving source unchanged');
  process.exit(0);
}
updated = updated.replace(oldTrailing, newTrailing);

fs.writeFileSync(path, updated);
console.log('[profit-protection] installed: break-even +10%, trailing activation +20%');
