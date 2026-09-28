// The before/after check (qa-plan §6.6): folders as well as files, in the places a run could write outside its sandbox.
// Other live sessions write under ~/.claude all the time, so it looks only at entries a run could create: the user skills
// folder, project and tmp folders named after this sandbox, this run's session envs, the product's default places, and in
// ~/.claude.json and settings.json only the keys a run could add. Any difference fails the run.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { realRoots, slug, type Roots } from './leftovers.ts';

export type Watch = Roots & {
  claudeJson: string;            // ~/.claude.json
  settingsJson: string;          // ~/.claude/settings.json
  productDefaults: string[];     // where the product writes when nothing points it elsewhere
  sandboxRoot: string;           // names in projects/ and the tmp folder are matched by this path's slug
  sessions: string[];            // this run's assistant sessions
  processGroups: number[];       // this run's process groups
};

// The product's default place (contract §4.5): $SKILLS_HOME and the local catalog live in ~/.skills-catalog/; no XDG folders.
// Installs go to ~/.claude/skills/<name>/, which the check watches anyway.
export const PRODUCT_DEFAULTS = (home: string) => [join(home, '.skills-catalog')];

export function realWatch(over: Partial<Watch> & { sandboxRoot: string }): Watch {
  const home = userInfo().homedir, roots = realRoots();
  return {
    ...roots, claudeJson: join(home, '.claude.json'), settingsJson: join(roots.claudeDir, 'settings.json'),
    productDefaults: PRODUCT_DEFAULTS(home), sessions: [], processGroups: [], ...over,
  };
}

/** What a run could add: whole values under these keys (and, for `projects`, entries for paths in the sandbox). */
const JSON_KEYS: Record<'claudeJson' | 'settingsJson', string[]> = {
  claudeJson: ['mcpServers'],
  settingsJson: ['hooks', 'mcpServers', 'enabledMcpjsonServers'],
};

type Entry = { kind: 'folder' | 'file' | 'key' | 'process'; label: string; sig: string };
export type Snapshot = Map<string, Entry>;
export type Difference = { key: string; what: string };

function walk(path: string, out: Snapshot): void {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (st.isDirectory()) {
    out.set(path, { kind: 'folder', label: path, sig: 'folder' });
    for (const n of readdirSync(path)) walk(join(path, n), out);
  } else {
    const sig = st.isFile() ? `file ${st.size} ${createHash('sha256').update(readFileSync(path)).digest('hex')}` : `other ${st.mode}`;
    out.set(path, { kind: 'file', label: path, sig });
  }
}

function readJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function snapshot(w: Watch): Snapshot {
  const out: Snapshot = new Map();
  const prefix = slug(w.sandboxRoot);
  const named = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n === prefix || n.startsWith(prefix + '-')) : []);
  walk(join(w.claudeDir, 'skills'), out);
  for (const n of named(join(w.claudeDir, 'projects'))) walk(join(w.claudeDir, 'projects', n), out);
  for (const id of w.sessions) walk(join(w.claudeDir, 'session-env', id), out);
  for (const n of named(w.claudeTmp)) walk(join(w.claudeTmp, n), out);
  for (const p of w.productDefaults) walk(p, out);
  for (const file of ['claudeJson', 'settingsJson'] as const) {
    const data = readJson(w[file]);
    for (const k of JSON_KEYS[file]) if (k in data) out.set(`${w[file]}\u0000${k}`, { kind: 'key', label: `${k} in ${w[file]}`, sig: JSON.stringify(data[k]) });
    if (file === 'claudeJson' && data.projects && typeof data.projects === 'object') {
      for (const p of Object.keys(data.projects)) {
        if (p === w.sandboxRoot || p.startsWith(w.sandboxRoot + '/')) out.set(`${w[file]}\u0000projects\u0000${p}`, { kind: 'key', label: `projects[${JSON.stringify(p)}] in ${w[file]}`, sig: 'present' });
      }
    }
  }
  for (const g of w.processGroups) {
    try { process.kill(-g, 0); out.set(`\u0001pgid ${g}`, { kind: 'process', label: `process group ${g}`, sig: 'running' }); } catch { /* gone */ }
  }
  return out;
}

export function compare(before: Snapshot, after: Snapshot): Difference[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out: Difference[] = [];
  for (const key of keys) {
    const a = before.get(key), b = after.get(key);
    if (a && b && a.sig === b.sig) continue;
    const e = (b ?? a)!;
    if (e.kind === 'process') { if (b) out.push({ key, what: `${e.label} still running` }); continue; }
    const noun = e.kind === 'key' ? 'key' : e.kind;
    const verb = !a ? 'added' : !b ? 'removed' : 'changed';
    out.push({ key, what: `${verb} ${noun} ${e.label}` });
  }
  return out;
}
