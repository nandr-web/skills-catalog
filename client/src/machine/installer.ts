// The installer (contract §3, §4.5, §5.3): install a shared skill into a skills folder, update installed skills, take a
// held update once the person says yes, list what's installed, set the update policy.
//
// The installer decides from bytes it checked. For each version it fetches it checks the bytes against the fingerprint
// and runs today's full validation with its own copy of the rules (skill-tree's checkFetched), then computes every risk
// flag itself from the verified bytes on both sides (skill-tree's diffTrees); the catalog's own flags are never read. A
// first install is an update from nothing. Any flag holds the change, with a confirm tied to the name and the new
// version's fingerprint, until accept_held_update. Files are written to a temp folder in SKILLS_HOME (outside every
// skills folder, which the assistant watches) and renamed in. Where a skill goes is computed from its target and name,
// never read from the lock. It never overwrites or shadows a skill it didn't install, and never installs through a link.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError, validateInput, type Catalog, type Surface, type VersionsResult } from '@skills-catalog/core';
import { checkFetched, diffTrees, flagText, type RiskFlag, type TreeDiff, type TreeFile } from '@skills-catalog/core/skill-tree';
import { reasons } from '@skills-catalog/core';
import { logWords } from '../activity.ts';
import type { Context, Done } from '../operations.ts';
import { policyOf, readConfig, readLock, writeConfig, writeLock, type Config, type Lock, type LockEntry, type Policy, type Target } from './lock.ts';

const quoted = (p: string) => JSON.stringify(p);
const TARGETS: readonly Target[] = ['user', 'project'];

// ---------- where skills go ----------

const rootOf = (ctx: Context, t: Target) => (t === 'user' ? ctx.settings.assistantHome : ctx.settings.projectDir);
export const skillsDir = (ctx: Context, t: Target) => join(rootOf(ctx, t), '.claude', 'skills');
const destOf = (ctx: Context, t: Target, name: string) => join(skillsDir(ctx, t), name);

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// The target folder, checked: no link on the way in, nothing there the lock doesn't own, and no untracked skill or
// command of the same name that this one would replace for the assistant. Returns where the skill goes.
function checkTarget(ctx: Context, target: Target, name: string, lock: Lock): string {
  const root = rootOf(ctx, target);
  for (const p of [join(root, '.claude'), skillsDir(ctx, target)]) if (isLink(p)) throw new CatalogError('target_symlink', { path: p });
  const dest = destOf(ctx, target, name);
  if (isLink(dest)) throw new CatalogError('target_symlink', { path: dest });
  if (existsSync(dest) && !lock.skills[dest]) throw new CatalogError('exists_untracked', { path: dest });
  for (const other of TARGETS.filter((t) => t !== target)) {
    const there = destOf(ctx, other, name);
    if (existsSync(there) && !lock.skills[there]) throw new CatalogError('name_in_use', { path: there });
  }
  for (const t of TARGETS) {
    const command = join(rootOf(ctx, t), '.claude', 'commands', `${name}.md`);
    if (existsSync(command)) throw new CatalogError('name_in_use', { path: command });
  }
  return dest;
}

// The files into a temp folder in SKILLS_HOME, then renamed into place; an installed copy is moved out first and
// removed once the new one is in (an update replaces local edits: the owner's call).
function writeSkill(ctx: Context, dest: string, files: readonly TreeFile[]): void {
  const staging = join(ctx.settings.home, 'staging');
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(staging, 'install-'));
  try {
    for (const f of files) {
      const full = join(tmp, f.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.bytes, { mode: f.mode === '0755' ? 0o755 : 0o644 });
    }
    mkdirSync(dirname(dest), { recursive: true });
    const old = existsSync(dest) ? `${tmp}-replaced` : undefined;
    if (old) renameSync(dest, old);
    try {
      renameSync(tmp, dest);
    } catch (e) {
      if (old) renameSync(old, dest);
      throw e;
    }
    if (old) rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- what the catalog sends, checked ----------

type Side = { version: number; fingerprint: string; publisher: string; files: TreeFile[] };

/** A fingerprint as the catalog claimed it, shown only in the fingerprint's form (§5.3 step 1). */
const inForm = (x: unknown) => (typeof x === 'string' && /^sha256:[0-9a-f]{64}$/.test(x) ? x : null);

/** A version's bytes, checked against `claimed`: the catalog's record of that version in its versions list, or the lock's
 *  for an installed copy; never the fingerprint sent with the bytes. A reply for another version than the one asked for
 *  is refused the same way. */
async function fetchChecked(catalog: Catalog, name: string, version: number, publisher: string, claimed: string | undefined): Promise<Side> {
  const r = await catalog.fetch({ name, version });
  const files = r.files.map((f) => ({ path: f.path, mode: f.mode, bytes: Buffer.from(f.content_base64, 'base64') }));
  if (r.version !== version) throw new CatalogError('fingerprint_mismatch', { name, version, expected: inForm(claimed), got: inForm(r.fingerprint) });
  const checked = checkFetched(name, version, claimed, files);
  // Past the check, `claimed` is the bytes' own fingerprint.
  return { version, fingerprint: claimed as string, publisher, files: checked };
}

/** The version `version` as the catalog's versions list records it, fetched and checked. */
const fetchListed = (catalog: Catalog, name: string, v: VersionsResult, version: number) => {
  const row = v.versions.find((x) => x.version === version);
  return fetchChecked(catalog, name, version, row?.publisher ?? '', row?.fingerprint);
};

/** The installed copy as the catalog holds it, checked against the lock. When it fails today's rules (stored under older
 *  ones) or can't be fetched, it counts as no version at all, so the new version is gated as a first install (fails
 *  closed); its publisher, from the lock, is still compared, since no rule changes who published. */
async function installedSide(catalog: Catalog, e: LockEntry): Promise<Side> {
  try {
    return await fetchChecked(catalog, e.name, e.version, e.publisher, e.fingerprint);
  } catch (err) {
    if (err instanceof CatalogError) return { version: e.version, fingerprint: e.fingerprint, publisher: e.publisher, files: [] };
    throw err;
  }
}

const gate = (from: Side | null, to: Side): TreeDiff => diffTrees(from && { files: from.files, publisher: from.publisher }, { files: to.files, publisher: to.publisher });

/** Every version's record, newest first, across pages. */
async function allVersions(catalog: Catalog, name: string): Promise<VersionsResult> {
  const first = await catalog.versions({ name });
  let cursor = first.next_cursor;
  const versions = [...first.versions];
  while (cursor) {
    const page = await catalog.versions({ name, cursor });
    versions.push(...page.versions);
    cursor = page.next_cursor;
  }
  return { ...first, versions };
}


// ---------- the confirm of a held change ----------

type Token = { name: string; target: Target; version: number; fingerprint: string; latest: number };
const encode = (t: Token) => Buffer.from(JSON.stringify(t)).toString('base64url');
function decode(confirm: string): Token {
  try {
    const t = JSON.parse(Buffer.from(confirm, 'base64url').toString('utf8'));
    if (typeof t.name === 'string' && TARGETS.includes(t.target) && Number.isSafeInteger(t.version) && typeof t.fingerprint === 'string' && Number.isSafeInteger(t.latest)) return t;
  } catch {
    // falls through
  }
  throw new CatalogError('invalid_request', { field: 'confirm', why: 'not_a_confirm' });
}

const kinds = (flags: readonly RiskFlag[]) => [...new Set(flags.map((f) => f.kind))].sort();
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((k) => y.has(k));
};

// ---------- words ----------

// Words the surface has on the agent-experience notes' main but not in the vendored copy yet: until the next vendoring,
// each is shown as its data (see operations.ts CLIENT_WORD_GAPS).
const asData = (what: string, data: unknown) => `${what}: ${JSON.stringify(data)}`;

const policyWords = (s: Surface, p: { policy: Policy; source: 'skill' | 'default' }) => {
  const name = s.word('policy_name')?.[p.policy];
  const source = s.word('policy_source')?.[p.source];
  return name !== undefined && source !== undefined ? name + source : p.policy;
};

function changesOf(s: Surface, d: TreeDiff): string {
  return d.files.map((f) => `${quoted(f.path)} ${f.status}`).join(', ');
}

// A refusal's reason in an update line: the error's subject and why, never the error's own sentence.
function refusalReason(s: Surface, e: CatalogError): string {
  const why = s.word('errors.why')?.[String(e.data['why'])];
  if (e.code === 'invalid_path' && typeof e.data['path'] === 'string' && why) return `${quoted(flagText(e.data['path']))} ${why}`;
  if (e.code === 'invalid_name' && why) return `${quoted('name')} ${why}`;
  return asData(e.code, e.data);
}

// ---------- what waits for the person ----------

/** The change waiting for the person's yes for `name`, as the installer would hold it now: an update of the copy
 *  installed here (either target), else a first install into `target`. `installed` is the installed version (none for
 *  a first install); null when nothing would be held (up to date, or nothing to flag). Its confirm and flags are what
 *  accept_held_update takes. */
export type Pending = { name: string; target: Target; installed?: number; version: number; reasons: string; confirm: string; flags: string[] };

export async function pendingHold(ctx: Context, name: string, target: Target = 'user'): Promise<Pending | { installed: number } | null> {
  const lock = readLock(ctx.settings.home);
  const e = installedHere(ctx, lock).find((x) => x.name === name);
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, name);
  if (e && v.latest === e.version) return { installed: e.version };
  const at = e ? e.target : target;
  if (!e) checkTarget(ctx, at, name, lock);
  const to = await fetchListed(catalog, name, v, v.latest);
  const flags = gate(e ? await installedSide(catalog, e) : null, to).risk_flags;
  if (!flags.length) return e ? { installed: e.version } : null;
  return {
    name,
    target: at,
    ...(e ? { installed: e.version } : {}),
    version: to.version,
    reasons: reasons(ctx.surface, flags),
    confirm: encode({ name, target: at, version: to.version, fingerprint: to.fingerprint, latest: v.latest }),
    flags: kinds(flags),
  };
}

// ---------- operations ----------

type InstallInput = { name: string; version?: number; target?: Target; policy?: Policy };

export async function install(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<InstallInput>('install_shared_skill', args, ctx.face);
  const s = ctx.surface;
  const log = logWords(s);
  const target = req.target ?? 'user';
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, req.name);
  const version = req.version ?? v.latest;
  const lock = readLock(ctx.settings.home);
  const dest = checkTarget(ctx, target, req.name, lock);
  const existing = lock.skills[dest];
  const to = await fetchListed(catalog, req.name, v, version);
  const from = existing ? await installedSide(catalog, existing) : null;
  const flags = gate(from, to).risk_flags;
  if (flags.length) {
    const w = s.word('install');
    const confirm = encode({ name: req.name, target, version, fingerprint: to.fingerprint, latest: v.latest });
    const text = s.format(ctx.face === 'cli' ? w.held_cli : w.held, { name: req.name, version, reasons: reasons(s, flags), confirm, flags: JSON.stringify(kinds(flags)) });
    return { text, target: `${req.name} v${version}`, result: log.result('install', 'held') };
  }
  writeSkill(ctx, dest, to.files);
  const entry = record(ctx, lock, dest, { name: req.name, target }, to, req.policy ?? existing?.policy, existing?.accepted ?? []);
  const w = s.word('install');
  const text = s.format(w.done, { name: req.name, version, path: quoted(dest), policy: policyWords(s, policyOf(entry, readConfig(ctx.settings.home))) }) + '\n' + s.format(w.live, { name: req.name });
  return { text, target: `${req.name} v${version}`, result: log.result('install', 'installed') };
}

function record(ctx: Context, lock: Lock, dest: string, at: { name: string; target: Target }, to: Side, policy: Policy | undefined, accepted: LockEntry['accepted']): LockEntry {
  const entry: LockEntry = {
    name: at.name,
    target: at.target,
    version: to.version,
    fingerprint: to.fingerprint,
    publisher: to.publisher,
    ...(policy ? { policy } : {}),
    path: dest,
    installed_at: ctx.now().toISOString(),
    catalog: ctx.settings.catalog,
    accepted,
  };
  lock.skills[dest] = entry;
  writeLock(ctx.settings.home, lock);
  return entry;
}

type AcceptInput = { name: string; confirm: string; flags: string[] };

export async function accept(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<AcceptInput>('accept_held_update', args, ctx.face);
  const s = ctx.surface;
  const t = decode(req.confirm);
  const conflict = () => new CatalogError('conflict', { name: req.name, held: true });
  if (t.name !== req.name) throw conflict();
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, req.name);
  if (v.latest !== t.latest) throw conflict();
  const lock = readLock(ctx.settings.home);
  const dest = checkTarget(ctx, t.target, req.name, lock);
  const existing = lock.skills[dest];
  const to = await fetchListed(catalog, req.name, v, t.version);
  if (to.fingerprint !== t.fingerprint) throw conflict();
  const flags = gate(existing ? await installedSide(catalog, existing) : null, to).risk_flags;
  if (!sameSet(req.flags, kinds(flags))) throw conflict();
  writeSkill(ctx, dest, to.files);
  const entry = record(ctx, lock, dest, { name: req.name, target: t.target }, to, existing?.policy, [...(existing?.accepted ?? []), { version: to.version, flags: kinds(flags) }]);
  const text = existing
    ? s.format(s.word('update.accepted'), { name: req.name, from: existing.version, to: to.version, path: quoted(dest) })
    : s.format(s.word('install.installed_after_yes'), { name: req.name, version: to.version, path: quoted(dest), policy: policyWords(s, policyOf(entry, readConfig(ctx.settings.home))) });
  return { text, target: `${req.name} v${to.version}`, result: logWords(s).result('accept') };
}

/** The lock's entries for this machine's user folder and this project, by name. */
function installedHere(ctx: Context, lock: Lock): LockEntry[] {
  return Object.entries(lock.skills)
    .filter(([key, e]) => TARGETS.includes(e.target) && key === destOf(ctx, e.target, e.name))
    .map(([, e]) => e)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.target < b.target ? -1 : 1));
}

type UpdateInput = { names?: string[]; dry_run?: boolean; latest?: boolean };

export async function update(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<UpdateInput>('update_installed_skills', args, ctx.face);
  const s = ctx.surface;
  const w = s.word('update');
  const log = logWords(s);
  const lock = readLock(ctx.settings.home);
  const config = readConfig(ctx.settings.home);
  const here = installedHere(ctx, lock);
  for (const name of req.names ?? []) if (!here.some((e) => e.name === name)) throw new CatalogError('not_installed', { name });
  const chosen = req.names ? here.filter((e) => req.names!.includes(e.name)) : here;
  if (!chosen.length) {
    const none = s.word('update.none_installed');
    return { text: typeof none === 'string' ? s.format(none) : asData('update', { checked: 0 }), target: '-', result: log.result('update', 'unchanged') };
  }
  const catalog = await ctx.catalog();
  const lines: string[] = [];
  const targets: string[] = [];
  let unchanged = 0;
  // The log's one word for the call: the outcome that most needs the person, else updated, else up to date.
  const RANK = ['unchanged', 'updated', 'held_pin', 'held_notify', 'held_flagged'];
  let outcome = 'unchanged';
  const saw = (o: string) => {
    if (RANK.indexOf(o) > RANK.indexOf(outcome)) outcome = o;
  };
  for (const e of chosen) {
    const dest = destOf(ctx, e.target, e.name);
    const v = await allVersions(catalog, e.name);
    if (v.latest === e.version) {
      unchanged++;
      continue;
    }
    const at = { name: e.name, from: e.version, to: v.latest };
    targets.push(`${e.name} v${e.version} → v${v.latest}`);
    const { policy } = policyOf(e, config);
    if (policy === 'pin') {
      lines.push(s.format(w.held_pin, at));
      saw('held_pin');
      continue;
    }
    if (policy === 'notify') {
      lines.push(s.format(w.held_notify, at));
      saw('held_notify');
      continue;
    }
    let to: Side;
    try {
      to = await fetchListed(catalog, e.name, v, v.latest);
    } catch (err) {
      if (!(err instanceof CatalogError)) throw err;
      const refusedFingerprint = s.word('update.refused_fingerprint');
      lines.push(
        err.code === 'fingerprint_mismatch'
          ? typeof refusedFingerprint === 'string' ? s.format(refusedFingerprint, at) : asData('refused', { ...at, error: err.toJSON() })
          : s.format(w.refused, { ...at, reason: refusalReason(s, err) }),
      );
      continue;
    }
    const d = gate(await installedSide(catalog, e), to);
    if (d.risk_flags.length) {
      const confirm = encode({ name: e.name, target: e.target, version: to.version, fingerprint: to.fingerprint, latest: v.latest });
      lines.push(s.format(w.held_flagged, { ...at, reasons: reasons(s, d.risk_flags) }));
      lines.push(s.format(ctx.face === 'cli' ? w.held_next_cli : w.held_next, { ...at, confirm, flags: JSON.stringify(kinds(d.risk_flags)) }));
      saw('held_flagged');
      continue;
    }
    if (req.dry_run) {
      lines.push(s.format(w.would_update, { ...at, changes: changesOf(s, d) }));
      continue;
    }
    writeSkill(ctx, dest, to.files);
    record(ctx, lock, dest, e, to, e.policy, e.accepted);
    lines.push(s.format(w.updated, { ...at, changes: changesOf(s, d) }));
    saw('updated');
  }
  if (unchanged) lines.push(s.format(w.unchanged, { n: unchanged }));
  const text = [s.format(w.header, { checked: chosen.length }), ...lines].join('\n');
  return { text, target: targets.join(', ') || '-', result: log.result('update', outcome) };
}

export async function list(ctx: Context): Promise<Done> {
  const s = ctx.surface;
  const lock = readLock(ctx.settings.home);
  const config = readConfig(ctx.settings.home);
  const here = installedHere(ctx, lock);
  const catalog = here.length ? await ctx.catalog() : undefined;
  const rows = [];
  for (const e of here) {
    const latest = (await catalog!.versions({ name: e.name })).latest;
    rows.push({ name: e.name, target: e.target, version: e.version, latest, policy: policyOf(e, config), state: latest === e.version ? 'same' : 'behind' });
  }
  const w = s.word('status');
  let text: string;
  if (!w || typeof w.header !== 'string') text = asData('list_installed_skills', rows.map((r) => ({ ...r, policy: r.policy.policy })));
  else if (!rows.length) text = s.format(w.empty);
  else {
    const lines = rows.map((r) => s.format(w.line, { name: r.name, version: r.version, state: s.format(w.state[r.state], { latest: r.latest }), policy: policyWords(s, r.policy) }));
    if (rows.some((r) => r.state === 'behind')) lines.push(s.format(w.next_behind));
    text = [s.format(w.header, { n: rows.length }), ...lines].join('\n');
  }
  return { text, target: rows.map((r) => `${r.name} v${r.version}`).join(', ') || '-', result: logWords(s).result('status') };
}

type PolicyInput = { policy: Policy; name?: string };

export async function setPolicy(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<PolicyInput>('set_skill_update_policy', args, ctx.face);
  const s = ctx.surface;
  const home = ctx.settings.home;
  const w = s.word('policy_set');
  const name = s.word('policy_name')?.[req.policy] ?? req.policy;
  if (req.name === undefined) {
    const config: Config = { ...readConfig(home), update_policy: req.policy };
    writeConfig(home, config);
    return { text: w ? s.format(w.default, { policy: name }) : asData('set_skill_update_policy', { policy: req.policy }), target: '-', result: logWords(s).result('policy') };
  }
  const lock = readLock(home);
  const entries = installedHere(ctx, lock).filter((e) => e.name === req.name);
  if (!entries.length) throw new CatalogError('not_installed', { name: req.name });
  for (const e of entries) lock.skills[destOf(ctx, e.target, e.name)] = { ...e, policy: req.policy };
  writeLock(home, lock);
  return { text: w ? s.format(w.skill, { name: req.name, policy: name }) : asData('set_skill_update_policy', { name: req.name, policy: req.policy }), target: req.name, result: logWords(s).result('policy') };
}
