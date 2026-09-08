const fs = require('node:fs');
const path = require('node:path');
const { DIFFICULTY_SIZES, generateLevel, isValidBoard } = require('../engine.js');

const bank = { easy: [], medium: [], hard: [] };
for (const [key, size] of Object.entries(DIFFICULTY_SIZES)) {
  const seen = new Set();
  for (let serial = 1; bank[key].length < 16; serial++) {
    const board = generateLevel(size, `curated-${key}-${serial}`);
    const signature = JSON.stringify(board);
    if (seen.has(signature) || !isValidBoard(board, true)) continue;
    seen.add(signature);
    bank[key].push(board);
  }
  console.log(key, bank[key].length, 'connected, unique boards');
}

const output = '/* Connected regions, each with one verified solution. */\n'
  + `const CAT_LEVELS = ${JSON.stringify(bank)};\n`
  + 'if (typeof module === "object" && module.exports) module.exports = CAT_LEVELS;\n';
fs.writeFileSync(path.join(__dirname, '../levels.js'), output);
