// The one-click demo's scene file (qa/demo/scenes.yaml): the developers, and per step what each one asks, the calls the
// stand-in assistant makes for it, what the person looks for, and the text each pane must show. Loaded and checked whole
// before anything runs: a scene file that can't play is refused with every reason.
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const SCENES_FILE = fileURLToPath(new URL('../../demo/scenes.yaml', import.meta.url));
export const SKILLS_DIR = fileURLToPath(new URL('../../demo/skills', import.meta.url));

export type Call =
  | { op: 'publish'; name: string; folder: string; message?: string }
  | { op: 'search'; query: string }
  | { op: 'read'; name: string }
  | { op: 'versions'; name: string }
  | { op: 'diff'; name: string; from: number; to: number }
  | { op: 'install'; name: string }
  | { op: 'update' }
  | { op: 'accept'; name: string }
  | { planned: string; why: string };
/** What the conductor types into the pane once it shows `after`, while the ask is still running (the person's y). */
export type Then = { type: string; after: string };
export type Ask = { who: string; say: string; calls: Call[]; then?: Then[] };
/** `expect_server`: more text each pane must show, only when the stand-ins call the catalog's server (qa demo --server). */
export type Step = { id: number; title: string; see: string; asks: Ask[]; expect: Record<string, string[]>; expect_server?: Record<string, string[]> };
export type Developer = { id: string; title: string; skills: string[] };
export type Scenes = { developers: Developer[]; steps: Step[] };

/** Each op's fields (required, then optional), and what a planned call may name: a surface tool's key or setup. */
const OPS: Record<string, { needs: Record<string, 'string' | 'integer'>; may?: Record<string, 'string'> }> = {
  publish: { needs: { name: 'string', folder: 'string' }, may: { message: 'string' } },
  search: { needs: { query: 'string' } },
  read: { needs: { name: 'string' } },
  versions: { needs: { name: 'string' } },
  diff: { needs: { name: 'string', from: 'integer', to: 'integer' } },
  install: { needs: { name: 'string' } },
  update: { needs: {} },
  accept: { needs: { name: 'string' } },
};
/** The ops the command line runs (install, and update with the person's --accept): only on the catalog's server; on the
 *  core in the stand-in's process they show as planned. */
export const CLI_OPS = ['install', 'update', 'accept'];
export const PLANNED = ['setup', 'install', 'update', 'accept', 'status', 'policy'];
/** A pane `expect` may name besides a developer. */
const PANES = ['steps', 'log'];
/** A developer id names a pane and a folder: a short plain word (and not a pane the window already has). */
export const DEVELOPER_ID = /^[a-z][a-z0-9-]{0,15}$/;

export class ScenesError extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown) => typeof x === 'string' && x.trim() !== '';
const stray = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).filter((k) => !keys.includes(k));

/** C0 (no exceptions: tab and line break too), DEL and C1. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const PLAIN = 'scene text must be plain text: it is shown in the panes and typed into them';
/** Every text and key with a control character, by where it is (`steps #2, asks #1, say`), never the text itself: a
 *  reason goes to the person's terminal. A key with one is reported without looking inside it. */
function controlCharacters(x: unknown, at: string, out: string[]): string[] {
  const code = (s: string) => { const c = CONTROL.exec(s)?.[0]; return c && `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`; };
  if (typeof x === 'string') { const c = code(x); if (c) out.push(`${at}: a control character (${c}); ${PLAIN}`); }
  else if (Array.isArray(x)) x.forEach((v, i) => controlCharacters(v, `${at} #${i + 1}`, out));
  else if (isObj(x)) {
    for (const [k, v] of Object.entries(x)) {
      const c = code(k);
      if (c) out.push(`${at || 'the file'}: a key with a control character (${c}); ${PLAIN}`);
      else controlCharacters(v, at ? `${at}, ${k}` : k, out);
    }
  }
  return out;
}

/** Check a parsed scene file; throws ScenesError with every problem, one per line. */
export function parseScenes(doc: unknown, skillsDir = SKILLS_DIR): Scenes {
  const bad: string[] = [];
  if (!isObj(doc)) throw new ScenesError('not a mapping with developers and steps');
  // first, and alone: the other reasons quote the file's text
  const control = controlCharacters(doc, '', []);
  if (control.length) throw new ScenesError(control.join('\n'));
  for (const k of stray(doc, ['developers', 'steps'])) bad.push(`unknown key ${k}`);
  const devs = Array.isArray(doc.developers) ? doc.developers : [];
  if (!devs.length) bad.push('no developers');
  const folders = new Map<string, string[]>();
  for (const [i, d] of devs.entries()) {
    const at = `developer ${isObj(d) && text(d.id) ? d.id : i + 1}`;
    if (!isObj(d) || !text(d.id) || !text(d.title) || !Array.isArray(d.skills)) { bad.push(`${at}: needs id, title and skills`); continue; }
    for (const k of stray(d, ['id', 'title', 'skills'])) bad.push(`${at}: unknown key ${k}`);
    if (!DEVELOPER_ID.test(d.id as string) || PANES.includes(d.id as string)) bad.push(`${at}: id must be 1-16 lowercase letters, digits or hyphens, starting with a letter, and not ${PANES.join(' or ')}`);
    if (folders.has(d.id as string)) bad.push(`${at} appears twice`);
    folders.set(d.id as string, d.skills as string[]);
    for (const f of d.skills) {
      if (!text(f) || /[/\\]|^\.\.?$/.test(f) || !existsSync(join(skillsDir, f, 'SKILL.md'))) bad.push(`${at}: no skill folder ${f} (with a SKILL.md) in ${skillsDir}`);
      else if (!lstatSync(join(skillsDir, f)).isDirectory()) bad.push(`${at}: skill folder ${f} is a link (only real folders are copied)`);
    }
  }
  const steps = Array.isArray(doc.steps) ? doc.steps : [];
  if (!steps.length) bad.push('no steps');
  const ids = new Set<unknown>(), asked = new Map<string, unknown>();
  for (const [i, s] of steps.entries()) {
    const at = `step ${isObj(s) && s.id !== undefined ? s.id : `#${i + 1}`}`;
    if (!isObj(s)) { bad.push(`${at}: not a mapping`); continue; }
    for (const k of stray(s, ['id', 'title', 'see', 'asks', 'expect', 'expect_server'])) bad.push(`${at}: unknown key ${k}`);
    if (!Number.isInteger(s.id) || (s.id as number) < 1) bad.push(`${at}: id must be a whole number from 1`);
    else if (ids.has(s.id)) bad.push(`${at} appears twice`);
    ids.add(s.id);
    if (!text(s.title)) bad.push(`${at}: no title`);
    if (!text(s.see)) bad.push(`${at}: no see (what the person looks for)`);
    const asks = Array.isArray(s.asks) ? s.asks : [];
    if (!asks.length) bad.push(`${at}: no asks`);
    for (const [j, a] of asks.entries()) {
      const aat = `${at}, ask ${j + 1}`;
      if (!isObj(a)) { bad.push(`${aat}: not a mapping`); continue; }
      for (const k of stray(a, ['who', 'say', 'calls', 'then'])) bad.push(`${aat}: unknown key ${k}`);
      if (a.then !== undefined && (!Array.isArray(a.then) || !a.then.length || !a.then.every((t) => isObj(t) && text(t.type) && text(t.after) && !stray(t, ['type', 'after']).length))) {
        bad.push(`${aat}: then must be a list of {type, after}, each non-empty text`);
      }
      if (!folders.has(a.who as string)) bad.push(`${aat}: who ${JSON.stringify(a.who)} is not a developer`);
      if (!text(a.say)) bad.push(`${aat}: no say (the line typed into the pane)`);
      else {
        const key = `${a.who}\n${(a.say as string).trim()}`;
        if (asked.has(key)) bad.push(`${aat}: ${a.who} already asks ${JSON.stringify(a.say)} in step ${asked.get(key)}`);
        asked.set(key, s.id);
      }
      const calls = Array.isArray(a.calls) ? a.calls : [];
      if (!calls.length) bad.push(`${aat}: no calls`);
      for (const [n, c] of calls.entries()) bad.push(...checkCall(c, `${aat}, call ${n + 1}`, a.who as string, folders.get(a.who as string)));
    }
    for (const key of ['expect', 'expect_server']) {
      if (s[key] === undefined) continue;
      if (!isObj(s[key])) { bad.push(`${at}: ${key} must map a pane to its strings`); continue; }
      for (const [pane, strings] of Object.entries(s[key])) {
        if (!folders.has(pane) && !PANES.includes(pane)) bad.push(`${at}: ${key} names ${pane}, which is not a developer, steps or log`);
        if (!Array.isArray(strings) || !strings.length || !strings.every(text)) bad.push(`${at}: ${key} ${pane} must be a list of non-empty strings`);
      }
    }
    // A step that calls the catalog counts as seen only once something is checked: without expect it would show ✓ unchecked.
    // The command line's ops play only on the catalog's server (planned on the core): expect_server checks them there.
    const calls = asks.flatMap((a) => (isObj(a) && Array.isArray(a.calls) ? a.calls : [])).filter((c) => isObj(c) && !('planned' in c));
    const has = (k: string) => isObj(s[k]) && Object.keys(s[k] as object).length > 0;
    if (calls.some((c) => !CLI_OPS.includes(c.op as string)) && !has('expect')) bad.push(`${at}: it calls the catalog, so it needs expect (the text that shows it worked)`);
    else if (calls.some((c) => CLI_OPS.includes(c.op as string)) && !has('expect') && !has('expect_server')) {
      bad.push(`${at}: it runs the command line, so it needs expect_server (the text that shows it worked on the catalog's server)`);
    }
  }
  if (bad.length) throw new ScenesError(bad.join('\n'));
  return {
    developers: devs as Developer[],
    steps: (steps as Record<string, unknown>[]).map((s) => ({ ...s, expect: (s.expect ?? {}) as Record<string, string[]>, expect_server: (s.expect_server ?? {}) as Record<string, string[]> }) as Step),
  };
}

function checkCall(c: unknown, at: string, who: string, folders: string[] | undefined): string[] {
  if (!isObj(c)) return [`${at}: not a mapping`];
  if ('planned' in c) {
    const bad = stray(c, ['planned', 'why']).map((k) => `${at}: unknown key ${k}`);
    if (!PLANNED.includes(c.planned as string)) bad.push(`${at}: unknown planned op ${JSON.stringify(c.planned)} (one of ${PLANNED.join(', ')})`);
    if (!text(c.why)) bad.push(`${at}: a planned call needs why (shown to the person)`);
    return bad;
  }
  const spec = OPS[c.op as string];
  if (!spec) return [`${at}: unknown op ${JSON.stringify(c.op)} (one of ${Object.keys(OPS).join(', ')}, or planned)`];
  const bad = stray(c, ['op', ...Object.keys(spec.needs), ...Object.keys(spec.may ?? {})]).map((k) => `${at}: unknown key ${k}`);
  const ok = (v: unknown, t: string) => (t === 'integer' ? Number.isInteger(v) && (v as number) >= 1 : text(v));
  for (const [k, t] of Object.entries(spec.needs)) if (!ok(c[k], t)) bad.push(`${at}: ${c.op} needs ${k} (${t === 'integer' ? 'a version number' : 'text'})`);
  for (const [k, t] of Object.entries(spec.may ?? {})) if (c[k] !== undefined && !ok(c[k], t)) bad.push(`${at}: ${k} must be text`);
  if (c.op === 'publish' && text(c.folder) && folders && !folders.includes(c.folder as string)) bad.push(`${at}: ${who} has no folder ${c.folder} (not in their skills)`);
  return bad;
}

/** The scene file: a path, else DEMO_SCENES, else qa/demo/scenes.yaml; its skill folders are in skills/ next to it.
 *  Refusals name the file. */
export function loadScenes(file = process.env.DEMO_SCENES || SCENES_FILE, skillsDir = join(dirname(file), 'skills')): Scenes {
  let doc: unknown;
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    doc = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ScenesError(`${file}: can't read it (${(e as Error).message})`);
  }
  try {
    return parseScenes(doc, skillsDir);
  } catch (e) {
    if (e instanceof ScenesError) throw new ScenesError(e.message.split('\n').map((l) => `${file}: ${l}`).join('\n'));
    throw e;
  }
}

/** The step and ask a typed line is, for one developer (the line trimmed, matched exactly). */
export function findAsk(s: Scenes, who: string, say: string): { step: Step; ask: Ask } | undefined {
  const line = say.trim();
  for (const step of s.steps) for (const ask of step.asks) if (ask.who === who && ask.say.trim() === line) return { step, ask };
  return undefined;
}
