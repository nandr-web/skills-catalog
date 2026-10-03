// The one environment every process a test starts gets, nothing inherited (the QA plan's rule): PATH is the tripwire
// claude first, then the system's folders and node's own; HOME and the other home-like places are in the test's
// sandbox, each refused by the fail-safe if it's anywhere else. And the source scan that keeps it so.

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { refuseRealPlaces, sandbox } from './sandbox.ts';

/** The tripwire `claude` in a sandbox's own bin folder: it notes each run in `ran` beside it and fails, so a child that
 *  looks up `claude` finds this, never a real one (the product never starts an assistant). */
export function tripwireBin(dir: string): string {
  const bin = join(dir, 'tripwire-bin');
  const claude = join(bin, 'claude');
  if (!existsSync(claude)) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(claude, `#!/bin/sh\necho "claude $*" >> '${join(bin, 'ran')}'\nexit 1\n`, { mode: 0o755 });
  }
  return bin;
}

/** The whole environment of a process a test starts, in the sandbox `dir` (a folder this test run made). */
export function processEnv(dir: string): Record<string, string> {
  refuseRealPlaces(dir);
  const home = join(dir, 'os-home');
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const env = {
    PATH: [tripwireBin(dir), '/usr/bin', '/bin', dirname(process.execPath)].join(':'),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    TMPDIR: tmp,
  };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR'] as const) refuseRealPlaces(env[k]);
  return env;
}

/** A program's absolute path as the test runner's own PATH finds it, for a test that needs that program (say, a Python
 *  newer than the system's) while its child still gets the built environment; undefined when it isn't there. */
export function onRunnerPath(name: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    const path = join(dir || '.', name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** A fifo at `path`, made by mkfifo with a built environment of its own. */
export function mkfifo(path: string): void {
  refuseRealPlaces(dirname(path));
  execFileSync('mkfifo', [path], { env: processEnv(sandbox()) });
}

// The calls that start a process, called by their own name (a method of the same name, `db.exec`, isn't one).
const START = /(?<![.\w$])(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*\(/g;
// child_process taken in under another name, which the scan couldn't follow.
const OTHER_NAME = [
  /import\s*\{[^}]*\bas\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/g,
  /import\s+(?:\*\s*as\s+)?\w+\s*(?:,\s*\{[^}]*\})?\s*from\s*['"](?:node:)?child_process['"]/g,
  /require\(\s*['"](?:node:)?child_process['"]\s*\)/g,
];

/** The text with every string's and comment's characters blanked (newlines kept), so a paren or a name inside one is
 *  never read as code. A quote in a regex literal can blank the rest of its line at most: ' and " end at a newline. */
function blanked(text: string): string {
  const out = text.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== '\n') out[j] = ' ';
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, text.length));
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

const lineAt = (text: string, at: number) => text.slice(0, at).split('\n').length;

/** The lines of `text` that start a process without giving it an env, or take child_process in under another name. */
export function callsWithoutEnv(text: string): number[] {
  const lines = new Set<number>();
  const code = blanked(text);
  // An import or require in code (its first letter isn't blanked), never one quoted in a string.
  for (const re of OTHER_NAME) for (const m of text.matchAll(re)) if (code[m.index] !== ' ') lines.add(lineAt(text, m.index));
  for (const m of code.matchAll(START)) {
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < code.length && depth > 0; j++) depth += code[j] === '(' ? 1 : code[j] === ')' ? -1 : 0;
    if (!/\benv\b/.test(code.slice(m.index, j))) lines.add(lineAt(text, m.index));
  }
  return [...lines].sort((a, b) => a - b);
}

/** Each `file:line` under `root` (its test tree, node_modules left out) that starts a process without an env. */
export function spawnsWithoutEnv(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(path);
      } else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(e.name)) {
        for (const line of callsWithoutEnv(readFileSync(path, 'utf8'))) found.push(`${relative(root, path)}:${line}`);
      }
    }
  };
  walk(root);
  return found.sort();
}
