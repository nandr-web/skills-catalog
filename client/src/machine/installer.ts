// The installer (contract §3, §4.5, §5.3): install a shared skill into a skills folder, update installed skills, take a
// held update once the person says yes, list what's installed, set the update policy.
//
// The installer decides from bytes it checked. For each version it fetches it checks the bytes against the fingerprint
// and runs today's full validation with its own copy of the rules (skill-tree's checkFetched), then computes every risk
// flag itself from the verified bytes on both sides (skill-tree's diffTrees); the catalog's own flags are never read. A
// first install is an update from nothing. Any flag holds the change, with a confirm tied to the name and the new
// version's fingerprint, until accept_held_update. Files are written to a temp folder in SKILLS_HOME (outside every
// skills folder, which the assistant watches) and renamed in. Where a skill goes is computed from its target and name,
// never read from the lock. It never overwrites or shadows a skill it didn't install. A link present when the call starts
// is refused. Every move is checked afterwards against the folders' identities taken when they were checked, and a
// failed check takes the copy back out and refuses (target_changed), never reporting success. The limit, said plainly:
// Node has no directory-relative file operations, so another program running as the same person can still race these
// checks; the installer narrows the window.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError, shellQuote, validateInput, type Catalog, type Surface, type VersionsResult } from '@skills-catalog/core';
import { checkFetched, checkName, diffTrees, flagText, type RiskFlag, type TreeDiff, type TreeFile } from '@skills-catalog/core/skill-tree';
import { reasons } from '@skills-catalog/core';
import { logWords } from '../activity.ts';
import type { Context, Done } from '../operations.ts';
import { policyOf, readRecords, writeConfig, writeLock, type FolderId, type Lock, type LockEntry, type Policy, type Target } from './lock.ts';

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

// .claude and .claude/skills under the target's root, made one folder at a time. Each is checked and its identity taken
// from the same lstat, so the identity is always a real folder's, never a link's own: a link that appeared since
// checkTarget is refused, not followed. writeSkill checks these identities again after every move. The folders it makes
// are 0755 whatever the umask, so they pass the privacy check (a umask of 002 would make them group-writable).
type Anchor = { path: string; id: Id };
function skillsFolderFor(dest: string): Anchor[] {
  const skills = dirname(dest);
  const claude = dirname(skills);
  mkdirSync(dirname(claude), { recursive: true, mode: 0o755 });
  return [claude, skills].map((path) => {
    try {
      mkdirSync(path, { mode: 0o755 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    return realFolder(path);
  });
}

// A folder that must be a real folder, not a link, private to the person, with its identity taken from the same lstat.
function realFolder(path: string): Anchor {
  const s = lstatOf(path);
  if (!s || s.isSymbolicLink()) throw new CatalogError('target_symlink', { path });
  if (!s.isDirectory()) throw new CatalogError('exists_untracked', { path });
  if (!isPrivate(s)) throw new CatalogError('target_not_private', { path });
  return { path, id: idFrom(s) };
}

// Private to the person (§4.5): owned by them, never world-writable, and group-writable only with their own private group
// (a umask of 002 with per-user groups). Otherwise another user could swap what the installer writes there.
function isPrivate(s: Stats): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  if (s.uid !== BigInt(uid) || (s.mode & 0o002n) !== 0n) return false;
  // Group-write only with the user's private group (its gid is the uid); never a shared group such as macOS's staff (20).
  return (s.mode & 0o020n) === 0n || (s.gid === BigInt(uid) && s.gid !== 20n);
}

// A folder's identity on disk, to tell whether a path still names the folder that was checked or installed: device,
// inode and birth time (left out where the file system reads it as 0). Entries recorded without a birth time compare on
// the other two.
// Stats are read as bigints, so identities compare exactly even where inode numbers pass 2^53 (overlay and network file
// systems); the lock stores them as numbers, and leaves `copy` out when they don't fit (such a copy is then kept, never
// deleted, like an entry from before identities were recorded).
type Stats = BigIntStats;
type Id = { dev: bigint; ino: bigint; birth?: bigint };
function lstatOf(path: string): Stats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
}
const idFrom = (s: Stats): Id => (s.birthtimeMs ? { dev: s.dev, ino: s.ino, birth: s.birthtimeMs } : { dev: s.dev, ino: s.ino });
function idOf(path: string): Id | undefined {
  const s = lstatOf(path);
  return s && idFrom(s);
}
const same = (a: Id | undefined, b: Id | undefined) =>
  a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino && (a.birth === undefined || b.birth === undefined || a.birth === b.birth);
/** An identity as the lock stores it, or nothing when it doesn't fit a safe integer. */
function toLock(id: Id): FolderId | undefined {
  const [dev, ino, birth] = [Number(id.dev), Number(id.ino), id.birth === undefined ? undefined : Number(id.birth)];
  if (![dev, ino, ...(birth === undefined ? [] : [birth])].every(Number.isSafeInteger)) return undefined;
  return birth === undefined ? { dev, ino } : { dev, ino, birth };
}
const fromLock = (c: FolderId | undefined): Id | undefined =>
  c && { dev: BigInt(c.dev), ino: BigInt(c.ino), ...(c.birth === undefined ? {} : { birth: BigInt(Math.trunc(c.birth)) }) };
/** A real folder (not a link) with this identity. */
const isCopy = (s: Stats | undefined, id: Id | undefined) => s !== undefined && s.isDirectory() && !s.isSymbolicLink() && same(idFrom(s), id);
/** Removes a folder only while it's a real folder with an identity the installer recorded; never by path alone. */
function removeIfOurs(path: string, id: Id | undefined): boolean {
  if (!isCopy(lstatOf(path), id)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

// Where a copy is staged: beside the skills folder, on the target's own volume, so every move is a rename.
export const STAGING = '.skills-catalog-staging';

// A rename that failed because something else is at (or gone from) one of its paths: a change under us, not a fault.
const RACED = new Set(['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR']);
function moved(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (e) {
    if (RACED.has((e as NodeJS.ErrnoException).code ?? '')) return false;
    throw e;
  }
}

// The files into a staging folder beside the skills folder, then renamed into place (contract §4.5, "Replacing an
// installed copy, safely"). `entry` is the lock's entry for this path, if any.
// - A first install finds nothing at the skill's path, or refuses without moving anything.
// - A replace moves the installed folder aside and deletes it only when it's a real folder with the identity the lock
//   recorded. An entry recorded before identities were kept never has its folder deleted: it's kept in staging, named.
// - After every move, .claude, .claude/skills and the staging folder must still be the real folders checked, and the
//   moved folder where it should be. Otherwise the move is undone as far as it safely can be, and the call refuses with
//   target_changed: `staging` names where a folder that couldn't be put back sits, and `elsewhere` says the new copy
//   may have gone where a swapped-in link pointed. It never reports success after a failed check.
// - Nothing is removed by path unless its identity is one recorded here.
// Returns the new copy's identity, for the lock, and where a replaced copy was kept, if it was.
function writeSkill(dest: string, files: readonly TreeFile[], entry: LockEntry | undefined): { copy: Id; kept?: string } {
  const anchors = skillsFolderFor(dest);
  const stagingDir = join(anchors[0]!.path, STAGING);
  let made = false;
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
    made = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const staging = realFolder(stagingDir);
  anchors.push(staging);
  const anchored = () => anchors.every((a) => isCopy(lstatOf(a.path), a.id));
  // A kept copy may hold the person's local edits: git ignores everything here, so `git add -A` can't commit it.
  if (made) writeFileSync(join(stagingDir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  const tmp = mkdtempSync(join(stagingDir, 'install-'));
  const copy = idOf(tmp)!;
  try {
    // Nothing is written until the folders are still the ones checked, and each file only while the temp folder is still
    // the one made here; files are created, never opened where something already stands.
    if (!anchored()) throw new CatalogError('target_changed', { path: dest });
    for (const f of files) {
      if (!isCopy(lstatOf(tmp), copy)) throw new CatalogError('target_changed', { path: dest });
      const full = join(tmp, f.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.bytes, { mode: f.mode === '0755' ? 0o755 : 0o644, flag: 'wx' });
    }
    // Folders left in staging because they couldn't be put back: named in the refusal (the staging folder itself when
    // more than one is there).
    const left: string[] = [];
    const refuse = (elsewhere = false): never => {
      const at = left.length === 0 ? {} : { staging: left.length === 1 ? left[0] : stagingDir };
      throw new CatalogError('target_changed', { path: dest, ...at, ...(elsewhere ? { elsewhere: true } : {}) });
    };
    // The folder the skill's path is in right now, through any link: where a folder moved out of it came from.
    const parentNow = (): Id | undefined => {
      try {
        return idFrom(statSync(dirname(dest), { bigint: true }));
      } catch {
        return undefined;
      }
    };
    // Puts a folder moved out of the skill's path back into the folder it came from, checking first that the path still
    // leads there; otherwise it stays in staging, named. If the path changed during the move back, it's taken out again.
    const restore = (aside: string, id: Id | undefined, from: Id | undefined): void => {
      const home = () => anchored() || same(parentNow(), from);
      if (!home() || !moved(aside, dest)) return void left.push(aside);
      if (home()) return;
      if (isCopy(lstatOf(dest), id) && moved(dest, aside)) left.push(aside);
    };

    const there = lstatOf(dest);
    if (there?.isSymbolicLink()) throw new CatalogError('target_symlink', { path: dest });
    let old: { path: string; id: Id | undefined; from: Id | undefined } | undefined;
    if (!entry) {
      if (there) throw new CatalogError('exists_untracked', { path: dest });
    } else if (there) {
      if (!anchored()) refuse();
      old = { path: `${tmp}-replaced`, id: undefined, from: undefined };
      // Where it came from is known only when the path led to the same folder just before and just after the move.
      const before = parentNow();
      if (!moved(dest, old.path)) refuse();
      const after = parentNow();
      old.from = same(before, after) ? after : undefined;
      const s = lstatOf(old.path);
      old.id = s && idFrom(s);
      const real = s !== undefined && s.isDirectory() && !s.isSymbolicLink();
      const ours = real && (entry.copy === undefined || same(old.id, fromLock(entry.copy)));
      if (!ours || !anchored()) {
        restore(old.path, old.id, old.from);
        refuse();
      }
    }
    if (!anchored() || !moved(tmp, dest)) {
      if (old) restore(old.path, old.id, old.from);
      refuse();
    }
    // The new copy must be where it was meant to go. If not, take it back out into a fresh staging path, and delete it
    // there only if it's still the copy made here; anything else is put back or kept, and named. A replaced copy can't be
    // put back safely then, so it stays in staging, named.
    if (!anchored() || !isCopy(lstatOf(dest), copy)) {
      let elsewhere = true;
      if (isCopy(lstatOf(dest), copy)) {
        const from = parentNow();
        const back = `${tmp}-back`;
        if (moved(dest, back)) {
          const s = lstatOf(back);
          if (removeIfOurs(back, copy)) elsewhere = false;
          else restore(back, s && idFrom(s), from);
        }
      }
      if (old) left.push(old.path);
      refuse(elsewhere);
    }
    if (!old) return { copy };
    // Deleted only when it's still the recorded copy; otherwise it's kept, and named.
    if (entry?.copy === undefined || !removeIfOurs(old.path, fromLock(entry.copy))) return { copy, kept: old.path };
    return { copy };
  } finally {
    removeIfOurs(tmp, copy);
    // The staging folder goes when nothing but its .gitignore is left, and only while it's the one checked here.
    if (isCopy(lstatOf(stagingDir), staging.id)) {
      try {
        const ignore = join(stagingDir, '.gitignore');
        if (readdirSync(stagingDir).every((f) => f === '.gitignore') && (lstatOf(ignore)?.isFile() ?? true)) {
          rmSync(ignore, { force: true });
          rmdirSync(stagingDir);
        }
      } catch {
        // something else is there now: a kept copy is named in the result
      }
    }
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
 *  a first install); null when nothing would be held (up to date, or nothing to flag). A "tell me first" skill's update
 *  is held with or without flags (`notify`). `path` is where it goes. Its confirm and flags are what accept_held_update
 *  takes. */
export type Pending = { name: string; target: Target; path: string; installed?: number; notify: boolean; version: number; reasons: string; confirm: string; flags: string[] };

export async function pendingHold(ctx: Context, name: string, target: Target = 'user'): Promise<Pending | { installed: number } | null> {
  const { lock, config } = readRecords(ctx.settings.home);
  const e = installedHere(ctx, lock).find((x) => x.name === name);
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, name);
  if (e && v.latest === e.version) return { installed: e.version };
  const at = e ? e.target : target;
  const path = checkTarget(ctx, at, name, lock);
  const to = await fetchListed(catalog, name, v, v.latest);
  const flags = gate(e ? await installedSide(catalog, e) : null, to).risk_flags;
  const notify = e !== undefined && policyOf(e, config).policy === 'notify';
  if (!flags.length && !notify) return e ? { installed: e.version } : null;
  return {
    name,
    target: at,
    path,
    ...(e ? { installed: e.version } : {}),
    notify,
    version: to.version,
    reasons: flags.length ? reasons(ctx.surface, flags) : '',
    confirm: encode({ name, target: at, version: to.version, fingerprint: to.fingerprint, latest: v.latest }),
    flags: kinds(flags),
  };
}

/** The command the person runs in their own terminal to take a held install into `target`. */
const acceptCommand = (s: Surface, name: string, target: Target) => [s.cli, ...['update', name, '--accept', ...(target === 'project' ? ['--target', 'project'] : [])].map(shellQuote)].join(' ');

// ---------- operations ----------

type InstallInput = { name: string; version?: number; target?: Target; policy?: Policy };

export async function install(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<InstallInput>('install_shared_skill', args, ctx.face);
  const s = ctx.surface;
  const log = logWords(s);
  const target = req.target ?? 'user';
  const { lock, config } = readRecords(ctx.settings.home);
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, req.name);
  const version = req.version ?? v.latest;
  const dest = checkTarget(ctx, target, req.name, lock);
  const existing = lock.skills[dest];
  const to = await fetchListed(catalog, req.name, v, version);
  const from = existing ? await installedSide(catalog, existing) : null;
  const flags = gate(from, to).risk_flags;
  if (flags.length) {
    const w = s.word('install');
    const confirm = encode({ name: req.name, target, version, fingerprint: to.fingerprint, latest: v.latest });
    const text = s.format(ctx.face === 'cli' ? w.held_cli : w.held, { name: req.name, version, reasons: reasons(s, flags), confirm, flags: JSON.stringify(kinds(flags)), command: acceptCommand(s, req.name, target) });
    return { text, target: `${req.name} v${version}`, result: log.result('install', 'held'), outcome: 'held' };
  }
  const written = writeSkill(dest, to.files, existing);
  const entry = record(ctx, lock, dest, { name: req.name, target }, to, req.policy ?? existing?.policy, existing?.accepted ?? [], toLock(written.copy));
  const w = s.word('install');
  const text = s.format(w.done, { name: req.name, version, path: quoted(dest), policy: policyWords(s, policyOf(entry, config)) }) + keptLine(s, req.name, written.kept) + '\n' + s.format(w.live, { name: req.name });
  return { text, target: `${req.name} v${version}`, result: log.result('install', 'installed'), outcome: 'installed' };
}

/** An update's line for a skill whose folder failed a check: the reason worded per code, else shown as its data. */
function refusedTarget(s: Surface, at: { name: string; from: number; to: number }, err: CatalogError): string {
  // A folder that changed mid-write may have left something in staging or elsewhere: its own line, not "nothing was written".
  if (err.code === 'target_changed') {
    const w = s.word('update.target_changed');
    return typeof w === 'string' ? s.format(w, { ...at, ...err.data }) : `- ${asData('target_changed', { ...at, ...err.data })}`;
  }
  const path = String(err.data['path']);
  const reason = s.word('update.target_reason')?.[err.code];
  return s.format(s.word('update.refused_target'), { ...at, path, reason: typeof reason === 'string' ? s.format(reason, { path }) : asData(err.code, err.data) });
}

/** The line naming where a replaced copy was kept (an entry recorded before identities were kept), or nothing. */
function keptLine(s: Surface, name: string, kept: string | undefined): string {
  if (kept === undefined) return '';
  const w = s.word('update.kept_in_staging');
  return '\n' + (typeof w === 'string' ? s.format(w, { name, staging: kept }) : asData('kept_in_staging', { name, staging: kept }));
}

function record(ctx: Context, lock: Lock, dest: string, at: { name: string; target: Target }, to: Side, policy: Policy | undefined, accepted: LockEntry['accepted'], copy: FolderId | undefined): LockEntry {
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
    ...(copy ? { copy } : {}),
  };
  lock.skills[dest] = entry;
  writeLock(ctx.settings.home, lock);
  return entry;
}

type AcceptInput = { name: string; confirm: string; flags: string[] };

export async function accept(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<AcceptInput>('accept_held_update', args, ctx.face);
  const s = ctx.surface;
  const { lock, config } = readRecords(ctx.settings.home);
  const t = decode(req.confirm);
  const conflict = () => new CatalogError('conflict', { name: req.name, held: true });
  if (t.name !== req.name) throw conflict();
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, req.name);
  if (v.latest !== t.latest) throw conflict();
  const dest = checkTarget(ctx, t.target, req.name, lock);
  const existing = lock.skills[dest];
  const to = await fetchListed(catalog, req.name, v, t.version);
  if (to.fingerprint !== t.fingerprint) throw conflict();
  const flags = gate(existing ? await installedSide(catalog, existing) : null, to).risk_flags;
  if (!sameSet(req.flags, kinds(flags))) throw conflict();
  const written = writeSkill(dest, to.files, existing);
  const entry = record(ctx, lock, dest, { name: req.name, target: t.target }, to, existing?.policy, [...(existing?.accepted ?? []), { version: to.version, flags: kinds(flags) }], toLock(written.copy));
  const text =
    (existing
      ? s.format(s.word('update.accepted'), { name: req.name, from: existing.version, to: to.version, path: quoted(dest) })
      : s.format(s.word('install.installed_after_yes'), { name: req.name, version: to.version, path: quoted(dest), policy: policyWords(s, policyOf(entry, config)) })) + keptLine(s, req.name, written.kept);
  return { text, target: `${req.name} v${to.version}`, result: logWords(s).result('accept'), outcome: existing ? 'updated' : 'installed' };
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
  const { lock, config } = readRecords(ctx.settings.home);
  const here = installedHere(ctx, lock);
  for (const name of req.names ?? []) if (!here.some((e) => e.name === name)) throw new CatalogError('not_installed', { name });
  const chosen = req.names ? here.filter((e) => req.names!.includes(e.name)) : here;
  if (!chosen.length) {
    const none = s.word('update.none_installed');
    return { text: typeof none === 'string' ? s.format(none) : asData('update', { checked: 0 }), target: '-', result: log.result('update', 'unchanged'), outcome: 'unchanged' };
  }
  const catalog = await ctx.catalog();
  const lines: string[] = [];
  const targets: string[] = [];
  let unchanged = 0;
  // The log's one word for the call: the outcome that most needs the person, else updated, else up to date.
  const RANK = ['unchanged', 'updated', 'refused', 'held_pin', 'held_notify', 'held_flagged'];
  let outcome = 'unchanged';
  const saw = (o: string) => {
    if (RANK.indexOf(o) > RANK.indexOf(outcome)) outcome = o;
  };
  // A refused skill: the log's word for it is the first refusal's error word.
  let refusal: string | undefined;
  const refused = (code: string) => {
    refusal ??= code;
    saw('refused');
  };
  for (const e of chosen) {
    const v = await allVersions(catalog, e.name);
    // A name reserved since it was installed is refused at every update, up to date or not (§5.3 step 2).
    try {
      checkName(e.name);
    } catch (err) {
      if (!(err instanceof CatalogError)) throw err;
      lines.push(s.format(w.refused, { name: e.name, from: e.version, to: v.latest, reason: refusalReason(s, err) }));
      refused(err.code);
      continue;
    }
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
    // Where it goes, checked as an install checks it: a link or a same-name skill or command may have appeared since.
    let dest: string;
    try {
      dest = checkTarget(ctx, e.target, e.name, lock);
    } catch (err) {
      if (!(err instanceof CatalogError)) throw err;
      lines.push(refusedTarget(s, at, err));
      refused(err.code);
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
      refused(err.code);
      continue;
    }
    const d = gate(await installedSide(catalog, e), to);
    const confirm = encode({ name: e.name, target: e.target, version: to.version, fingerprint: to.fingerprint, latest: v.latest });
    // "Tell me first" holds every new version, flagged or not (§5.3: pin, then notify, then the flags); it's taken with
    // the flags it shows, [] when none.
    if (policy === 'notify') {
      lines.push(d.risk_flags.length ? s.format(w.held_notify_flagged, { ...at, reasons: reasons(s, d.risk_flags) }) : s.format(w.held_notify, at));
      lines.push(s.format(ctx.face === 'cli' ? w.held_notify_next_cli : w.held_notify_next, { ...at, confirm, flags: JSON.stringify(kinds(d.risk_flags)) }));
      saw('held_notify');
      continue;
    }
    if (d.risk_flags.length) {
      lines.push(s.format(w.held_flagged, { ...at, reasons: reasons(s, d.risk_flags) }));
      lines.push(s.format(ctx.face === 'cli' ? w.held_next_cli : w.held_next, { ...at, confirm, flags: JSON.stringify(kinds(d.risk_flags)) }));
      saw('held_flagged');
      continue;
    }
    if (req.dry_run) {
      lines.push(s.format(w.would_update, { ...at, changes: changesOf(s, d) }));
      continue;
    }
    // A folder that changed while it was being written is that skill's refused line; the other skills go on.
    let written: ReturnType<typeof writeSkill>;
    try {
      written = writeSkill(dest, to.files, e);
    } catch (err) {
      if (!(err instanceof CatalogError)) throw err;
      lines.push(refusedTarget(s, at, err));
      refused(err.code);
      continue;
    }
    record(ctx, lock, dest, e, to, e.policy, e.accepted, toLock(written.copy));
    lines.push(s.format(w.updated, { ...at, changes: changesOf(s, d) }) + keptLine(s, e.name, written.kept));
    saw('updated');
  }
  if (unchanged) lines.push(s.format(w.unchanged, { n: unchanged }));
  const text = [s.format(w.header, { checked: chosen.length }), ...lines].join('\n');
  return { text, target: targets.join(', ') || '-', result: outcome === 'refused' ? log.error(refusal!) : log.result('update', outcome), outcome };
}

export async function list(ctx: Context): Promise<Done> {
  const s = ctx.surface;
  const { lock, config } = readRecords(ctx.settings.home);
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
  const { lock, config } = readRecords(home);
  if (req.name === undefined) {
    writeConfig(home, { ...config, update_policy: req.policy });
    return { text: w ? s.format(w.default, { policy: name }) : asData('set_skill_update_policy', { policy: req.policy }), target: '-', result: logWords(s).result('policy') };
  }
  const entries = installedHere(ctx, lock).filter((e) => e.name === req.name);
  if (!entries.length) throw new CatalogError('not_installed', { name: req.name });
  for (const e of entries) lock.skills[destOf(ctx, e.target, e.name)] = { ...e, policy: req.policy };
  writeLock(home, lock);
  return { text: w ? s.format(w.skill, { name: req.name, policy: name }) : asData('set_skill_update_policy', { name: req.name, policy: req.policy }), target: req.name, result: logWords(s).result('policy') };
}
