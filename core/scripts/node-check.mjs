// Runs before anything else (contract §8): skills-catalog needs Node 24.15 or later, with FTS5 compiled into
// node:sqlite. Plain JavaScript on purpose, so an older Node can run it and say so in one line (exit 3, nothing
// changed) instead of failing on the TypeScript that follows.
//
//   node scripts/node-check.mjs && <the real command>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NEED = '24.15.0';

const parts = (v) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);

// What's wrong with this Node, or null: too_old, or no_fts5 (search needs it).
export function nodeProblem(have, hasFts5) {
  const [a, b, c] = parts(have);
  const [x, y, z] = parts(NEED);
  const older = a !== x ? a < x : b !== y ? b < y : c < z;
  if (older) return { problem: 'too_old', need: NEED, have };
  if (!hasFts5) return { problem: 'no_fts5', need: NEED, have };
  return null;
}

async function fts5() {
  // Loading node:sqlite prints Node's ExperimentalWarning; only that one class is dropped (an older Node has no
  // --disable-warning flag to run this script with).
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? w?.name;
    if (type !== 'ExperimentalWarning') emit.call(process, w, ...rest);
  };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE t USING fts5 (x)');
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  } finally {
    process.emitWarning = emit;
  }
}

// The line to print, in the words when they exist; otherwise the problem as data (never hand-typed prose).
export async function problemLine(p) {
  try {
    const { parse } = await import('yaml');
    const words = parse(readFileSync(new URL('../words/words.yaml', import.meta.url), 'utf8'))?.results?.[`node_${p.problem}`];
    if (typeof words === 'string') return words.replace(/\{(need|have)\}/g, (_, k) => p[k]);
  } catch {
    // fall through to the data
  }
  return `${p.problem}: need ${p.need}; have ${p.have}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const have = process.versions.node;
  const p = nodeProblem(have, nodeProblem(have, true) === null ? await fts5() : true);
  if (p) {
    process.stderr.write(`${await problemLine(p)}\n`);
    process.exit(3);
  }
}
