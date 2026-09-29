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

import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { CatalogError, inlineFiles, shellQuote, validateInput, type Catalog, type Words, type VersionsResult } from '@skills-catalog/core';
import { DEFAULT_LIMITS, checkFetched, checkName, diffTrees, fingerprint, flagText, sha256Hex, type RiskFlag, type TreeDiff, type TreeFile } from '@skills-catalog/core/skill-tree';
import { reasons } from '@skills-catalog/core';
import { logWords } from '../activity.ts';
import { permissiveMode } from './permissive.ts';
import { holdWithinADay, recordUsage, type HoldReason, type UsageEvent } from '../usage/record.ts';
import type { Context, Done } from '../operations.ts';
import { holdLock, policyOf, readRecords, withLock, writeConfig, type FolderId, type Lock, type LockEntry, type Policy, type Target } from './lock.ts';

const quoted = (p: string) => JSON.stringify(p);
const TARGETS: readonly Target[] = ['user', 'project'];

// ---------- where skills go ----------

const rootOf = (ctx: Context, t: Target) => (t === 'user' ? ctx.settings.assistantHome : ctx.settings.projectDir);
/** SKILLS_INSTALL_DIR stands in for the user target's .claude/skills (§8): an absolute path, whose parent takes .claude's
 *  checks and the folder above that the private-folder test (it isn't the assistant home). A limit, stated: pointed at
 *  the current project's .claude/skills, both targets are one folder. */
const standsIn = (ctx: Context, t: Target) => t === 'user' && ctx.settings.installDir !== undefined;
export function skillsDir(ctx: Context, t: Target): string {
  if (!standsIn(ctx, t)) return join(rootOf(ctx, t), '.claude', 'skills');
  const dir = ctx.settings.installDir!;
  if (!isAbsolute(dir)) throw new CatalogError('invalid_request', { field: 'SKILLS_INSTALL_DIR', why: 'not_absolute' });
  return dir;
}
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
  for (const p of [dirname(skillsDir(ctx, target)), skillsDir(ctx, target)]) if (isLink(p)) throw new CatalogError('target_symlink', { path: p });
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
// are 0755 whatever the umask (madeAs), so they pass the privacy check (a umask of 002 would make them group-writable).
type Anchor = { path: string; id: Id };
function skillsFolderFor(dest: string, target: Target, standIn = false): Anchor[] {
  const skills = dirname(dest);
  const claude = dirname(skills);
  const root = dirname(claude);
  // A folder on the way that can't be made (no permission, a read-only file system, a missing or non-folder parent) is a
  // target that isn't there, with a way on (HOME=/nonexistent in CI); anything else making it is a fault.
  const make = (at: string) => {
    try {
      makeFolder(at, 0o755);
    } catch (e) {
      if (!UNMAKEABLE.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      throw new CatalogError('target_unavailable', { path: at, target, ...(at === root && target === 'user' && !standIn ? { home: true } : {}) });
    }
  };
  const missing: string[] = [];
  for (let at = root; !existsSync(at) && dirname(at) !== at; at = dirname(at)) missing.unshift(at);
  for (const at of missing) make(at);
  // The folder above .claude (§4.5), which may be reached through a link: whoever can write it can put their own .claude
  // in its place. The assistant home is held to the same rule as .claude. A project folder is the person's or root's
  // (its owner can always rename what's in it, sticky bit or not), and writable by others only as that rule allows (a
  // shared group, macOS's staff included, is every member's way in), unless it has the sticky bit, as /tmp does.
  const r = statSync(root, { bigint: true });
  const uid = process.getuid?.();
  const ownedWell = uid !== undefined && (r.uid === BigInt(uid) || r.uid === 0n);
  const open = target === 'user' ? !isPrivate(r) : uid !== undefined && (!ownedWell || ((r.mode & 0o1000n) === 0n && !writableOnlyAsPrivate(r)));
  if (open) throw notPrivate(root, target, r, target === 'user' && !standIn);
  return [claude, skills].map((path) => {
    make(path);
    return realFolder(path, target);
  });
}
const UNMAKEABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR']);

// Modes set exactly, whatever the umask: a umask of 002 would leave a skill's folders group-writable (on macOS the group
// is staff, every local user), and a strict one could leave an executable unrunnable. Set through a handle that doesn't
// follow a link, so a link swapped in is never changed.
function madeAs(path: string, mode: number): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}
/** Makes a folder with exactly `mode`; one already there is left as it is. Returns whether it was made here. */
function makeFolder(path: string, mode: number): boolean {
  try {
    mkdirSync(path, { mode });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  }
  madeAs(path, mode);
  return true;
}
/** A new file with exactly `mode`, created, never opened where something already stands. */
function writeNew(path: string, bytes: Uint8Array, mode: number): void {
  const fd = openSync(path, 'wx', mode);
  try {
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

// A folder that must be a real folder, not a link, private to the person, with its identity taken from the same lstat.
function realFolder(path: string, target: Target): Anchor {
  const s = lstatOf(path);
  if (!s || s.isSymbolicLink()) throw new CatalogError('target_symlink', { path });
  if (!s.isDirectory()) throw new CatalogError('exists_untracked', { path });
  if (!isPrivate(s)) throw notPrivate(path, target, s);
  return { path, id: idFrom(s) };
}

// The refusal names the folder, the target, whether it's the assistant home, and whether it's the person's own, so the
// words can offer the way on that fits (chmod only on their own folder).
function notPrivate(path: string, target: Target, s: Stats, home = false): CatalogError {
  return new CatalogError('target_not_private', { path, target, ...(home ? { home: true } : {}), own: s.uid === BigInt(process.getuid?.() ?? -1) });
}

// Private to the person (§4.5): owned by them, never world-writable, and group-writable only with their own private group
// (a umask of 002 with per-user groups). Otherwise another user could swap what the installer writes there.
function isPrivate(s: Stats): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  return s.uid === BigInt(uid) && writableOnlyAsPrivate(s);
}
// Never world-writable, and group-writable only with the user's private group (its gid is the uid); never a shared group
// such as macOS's staff (20).
function writableOnlyAsPrivate(s: Stats): boolean {
  const uid = BigInt(process.getuid?.() ?? -1);
  if ((s.mode & 0o002n) !== 0n) return false;
  return (s.mode & 0o020n) === 0n || (s.gid === uid && s.gid !== 20n);
}

// A folder's identity on disk, to tell whether a path still names the folder that was checked or installed: device,
// inode and birth time (left out where the file system reads it as 0). Entries recorded without a birth time compare on
// the other two.
// Stats are read as bigints, so identities compare exactly even where inode numbers pass 2^53 (overlay and network file
// systems); the lock stores each part as a number while it's a safe integer, and past that as its decimal string.
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
/** An identity as the lock stores it: each part a number while it's a safe integer, otherwise its decimal string. */
const toPart = (n: bigint): number | string => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString());
function toLock(id: Id): FolderId {
  return { dev: toPart(id.dev), ino: toPart(id.ino), ...(id.birth === undefined ? {} : { birth: toPart(id.birth) }) };
}
/** Read back exactly, whichever form each part was stored in; a birth time is whole milliseconds. */
const fromPart = (n: number | string): bigint => (typeof n === 'number' ? BigInt(Math.floor(n)) : BigInt(n));
const fromLock = (c: FolderId | undefined): Id | undefined =>
  c && { dev: fromPart(c.dev), ino: fromPart(c.ino), ...(c.birth === undefined ? {} : { birth: fromPart(c.birth) }) };
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
function writeSkill(dest: string, target: Target, files: readonly TreeFile[], entry: LockEntry | undefined, standIn = false): { copy: Id; kept?: string } {
  // A staging folder already there is checked before anything is made, so a refusal for it leaves nothing behind.
  const early = join(dirname(dirname(dest)), STAGING);
  if (existsSync(early)) realFolder(early, target);
  const anchors = skillsFolderFor(dest, target, standIn);
  const stagingDir = join(anchors[0]!.path, STAGING);
  const made = makeFolder(stagingDir, 0o700);
  const staging = realFolder(stagingDir, target);
  anchors.push(staging);
  // The first path that failed its check, for the refusal: a checked folder, the skill's path or the temp folder.
  let failed: string | undefined;
  const anchored = () => {
    const bad = anchors.find((a) => !isCopy(lstatOf(a.path), a.id));
    if (bad) failed ??= bad.path;
    return bad === undefined;
  };
  const changed = () => new CatalogError('target_changed', { path: failed, ...(failed === stagingDir ? { temp: true } : {}) });
  // The staging folder is looked at again, through its whole path, before its .gitignore and the temp folder are made in
  // it, so a link swapped in for it (or for a folder above it) right after its check doesn't take them where it points. A
  // .gitignore already there in a staging folder made just now means another folder was put in its place.
  const stagingThere = () => {
    if (isCopy(lstatOf(stagingDir), staging.id)) return;
    failed ??= stagingDir;
    throw changed();
  };
  // A kept copy may hold the person's local edits: git ignores everything here, so `git add -A` can't commit it.
  if (made) {
    stagingThere();
    try {
      writeFileSync(join(stagingDir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      failed ??= stagingDir;
      throw changed();
    }
  }
  stagingThere();
  const tmp = mkdtempSync(join(stagingDir, 'install-'));
  madeAs(tmp, 0o700);
  const copy = idOf(tmp)!;
  try {
    // Nothing is written until the folders are still the ones checked, and each file only while the temp folder is still
    // the one made here; files are created, never opened where something already stands. Once a file was written, a temp
    // folder that fails its check may have taken it somewhere else: the refusal says so.
    if (!anchored()) throw changed();
    let wrote = false;
    const tmpChanged = () => new CatalogError('target_changed', { path: tmp, temp: true, ...(wrote ? { elsewhere: true } : {}) });
    for (const f of files) {
      if (!isCopy(lstatOf(tmp), copy)) throw tmpChanged();
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) makeFolder(join(tmp, ...parts.slice(0, i)), 0o755);
      writeNew(join(tmp, f.path), f.bytes, f.mode === '0755' ? 0o755 : 0o644);
      wrote = true;
    }
    madeAs(tmp, 0o755);
    // Folders left in staging because they couldn't be put back: named in the refusal (the staging folder itself when
    // more than one is there).
    const left: string[] = [];
    // `path` is the first path that failed its check; `temp` says it's a staging folder (the temp folder, or staging itself).
    const refuse = (elsewhere = false): never => {
      const at = left.length === 0 ? {} : { staging: left.length === 1 ? left[0] : stagingDir };
      const path = failed ?? dest;
      const temp = path === tmp || path === stagingDir;
      throw new CatalogError('target_changed', { path, ...(temp ? { temp: true } : {}), ...at, ...(elsewhere ? { elsewhere: true } : {}) });
    };
    // Puts a folder moved out of the skill's path back, only while the checked folders are still the real ones at their
    // paths: nothing moves through a swapped-in link, even one leading to the same folder moved elsewhere. Otherwise it
    // stays in staging, named. If the path changed during the move back, it's taken out again.
    const restore = (aside: string, id: Id | undefined): void => {
      if (!anchored() || !moved(aside, dest)) return void left.push(aside);
      if (anchored()) return;
      if (isCopy(lstatOf(dest), id) && moved(dest, aside)) left.push(aside);
    };
    // A link where a checked folder was: nothing is moved through it.
    const linkOnTheWay = () => anchors.some((a) => lstatOf(a.path)?.isSymbolicLink() ?? false);

    const there = lstatOf(dest);
    if (there?.isSymbolicLink()) throw new CatalogError('target_symlink', { path: dest });
    let old: { path: string; id: Id | undefined } | undefined;
    if (!entry) {
      if (there) throw new CatalogError('exists_untracked', { path: dest });
    } else if (there) {
      // Only a real folder can be the installed copy, or the person's recreation of it.
      if (!there.isDirectory()) throw new CatalogError('exists_untracked', { path: dest });
      if (!anchored()) refuse();
      old = { path: `${tmp}-replaced`, id: undefined };
      if (!moved(dest, old.path)) {
        failed ??= dest;
        refuse();
      }
      const s = lstatOf(old.path);
      old.id = s && idFrom(s);
      // A real folder whose identity isn't the recorded copy's, while the checked folders hold, was recreated by the
      // person or their tools (a restore, a branch switch): it's replaced like any copy but kept in staging, never
      // deleted, below. Anything else moved out, or checked folders that changed, is put back and refused.
      const real = s !== undefined && s.isDirectory() && !s.isSymbolicLink();
      const held = anchored();
      if (!real) failed ??= dest;
      if (!real || !held) {
        restore(old.path, old.id);
        refuse();
      }
    }
    // The temp folder is checked once more just before it's moved in, so a folder swapped in for it is never moved in.
    if (!isCopy(lstatOf(tmp), copy)) {
      failed ??= tmp;
      if (old) restore(old.path, old.id);
      refuse(wrote);
    }
    if (!anchored() || !moved(tmp, dest)) {
      failed ??= dest;
      if (old) restore(old.path, old.id);
      refuse();
    }
    // The new copy must be where it was meant to go. If not, take it back out into a fresh staging path (never through a
    // link that appeared where a checked folder was: then it went where the link leads, and the refusal says a copy may
    // be elsewhere), and delete it there only if it's still the copy made here; anything else is put back or kept, and
    // named. Then a replaced copy goes back if the checked folders are still the real ones, and otherwise stays in
    // staging, named.
    if (!anchored() || !isCopy(lstatOf(dest), copy)) {
      failed ??= dest;
      let elsewhere = true;
      if (!linkOnTheWay() && isCopy(lstatOf(dest), copy)) {
        const back = `${tmp}-back`;
        if (moved(dest, back)) {
          const s = lstatOf(back);
          if (removeIfOurs(back, copy)) elsewhere = false;
          else restore(back, s && idFrom(s));
        }
      }
      if (old) restore(old.path, old.id);
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
  const files = inlineFiles(r).map((f) => ({ path: f.path, mode: f.mode, bytes: Buffer.from(f.content_base64, 'base64') }));
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

// Words the words file has on the agent-experience notes' main but not in the vendored copy yet: until the next vendoring,
// each is shown as its data (see operations.ts CLIENT_WORD_GAPS).
const asData = (what: string, data: unknown) => `${what}: ${JSON.stringify(data)}`;

const policyWords = (s: Words, p: { policy: Policy; source: 'skill' | 'default' }) => {
  const name = s.word('policy_name')?.[p.policy];
  const source = s.word('policy_source')?.[p.source];
  return name !== undefined && source !== undefined ? name + source : p.policy;
};

function changesOf(s: Words, d: TreeDiff): string {
  return d.files.map((f) => `${quoted(f.path)} ${f.status}`).join(', ');
}

// A refusal's reason in an update line: the error's subject and why, never the error's own sentence.
function refusalReason(s: Words, e: CatalogError): string {
  const why = s.word('errors.why')?.[String(e.data['why'])];
  if (e.code === 'invalid_path' && typeof e.data['path'] === 'string' && why) return `${quoted(flagText(e.data['path']))} ${why}`;
  if (e.code === 'invalid_name' && why) return `${quoted('name')} ${why}`;
  return asData(e.code, e.data);
}

// ---------- what waits for the person ----------

/** The change waiting for the person's yes for `name`, as the installer would hold it now: an update of the copy
 *  installed here (either target), else a first install into `target`. `installed` is the installed version (none for
 *  a first install); null when nothing would be held (up to date, or nothing to flag). `reason` is why it waits, in
 *  §5.3's order: a copy from another catalog (`was`, where it came from; `now`, the catalog in use), pinned, "tell me
 *  first" (`notify`; held with or without flags), else its flags. `path` is where it goes. Its confirm and flags are
 *  what accept_held_update takes. */
export type Pending = {
  name: string;
  target: Target;
  path: string;
  installed?: number;
  reason: 'other_catalog' | 'pin' | 'notify' | 'flagged';
  notify: boolean;
  was?: string;
  now?: string;
  version: number;
  reasons: string;
  confirm: string;
  flags: string[];
};

export async function pendingHold(ctx: Context, name: string, target: Target = 'user'): Promise<Pending | { installed: number } | null> {
  const { lock, config } = readRecords(ctx.settings.home);
  const e = installedHere(ctx, lock).find((x) => x.name === name);
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, name);
  // The same version from another catalog still waits (an install held it as other_catalog).
  if (e && v.latest === e.version && e.catalog === ctx.settings.catalog) return { installed: e.version };
  const at = e ? e.target : target;
  const path = checkTarget(ctx, at, name, lock);
  const to = await fetchListed(catalog, name, v, v.latest);
  const flags = gate(e ? await installedSide(catalog, e) : null, to).risk_flags;
  const why = e ? holdOf(ctx, e, config) : undefined;
  if (!flags.length && !why) return e ? { installed: e.version } : null;
  return {
    name,
    target: at,
    path,
    ...(e ? { installed: e.version } : {}),
    reason: why ?? 'flagged',
    notify: why === 'notify',
    ...(e && why === 'other_catalog' ? { was: e.catalog, now: ctx.settings.catalog } : {}),
    version: to.version,
    reasons: flags.length ? reasons(ctx.words, flags) : '',
    confirm: encode({ name, target: at, version: to.version, fingerprint: to.fingerprint, latest: v.latest }),
    flags: kinds(flags),
  };
}

/** The command the person runs in their own terminal to take a held install into `target`. */
const acceptCommand = (s: Words, name: string, target: Target) => [s.cli, ...['update', name, '--accept', ...(target === 'project' ? ['--target', 'project'] : [])].map(shellQuote)].join(' ');

// ---------- operations ----------

/** An update's result as data, for a person's view (person/view.ts). An item's `lines` are the words the text gives it. */
export type UpdateItem = { kind: 'updated' | 'would_update' | 'held_flagged' | 'held_notify' | 'held_pin' | 'held_other_catalog' | 'refused'; name: string; from: number; to: number; flags: RiskFlag[]; lines: string[] };
export type UpdateView = { kind: 'update'; checked: number; unchanged: number; dry_run: boolean; items: UpdateItem[] };
/** The installed skills as data, for a person's view. */
export type ListView = { kind: 'list'; rows: { name: string; target: Target; version: number; latest: number; policy: Policy; policy_words: string; state: 'same' | 'behind' }[] };

type InstallInput = { name: string; version?: number; target?: Target; policy?: Policy };

export async function install(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<InstallInput>('install_shared_skill', args, ctx.face, 'local');
  const s = ctx.words;
  const log = logWords(s);
  const target = req.target ?? 'user';
  const { lock, config } = readRecords(ctx.settings.home);
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, req.name);
  const version = req.version ?? v.latest;
  const dest = checkTarget(ctx, target, req.name, lock);
  const existing = lock.skills[dest];
  const to = await fetchListed(catalog, req.name, v, version);
  const w = s.word('install');
  // A copy from another catalog is held first, whatever the version: the same version number there is another skill.
  const otherCatalog = existing !== undefined && existing.catalog !== ctx.settings.catalog;
  // The same version over an intact copy (its files are the lock's fingerprint) changes nothing; a copy the person
  // recreated just has its identity recorded again. A changed or incomplete copy is written again, whatever the policy.
  if (existing && !otherCatalog && existing.version === version && to.fingerprint === existing.fingerprint && folderFingerprint(dest) === existing.fingerprint) {
    await recordAgain(ctx, dest, target, existing);
    return { text: s.format(w.unchanged, { name: req.name, version }), target: `${req.name} v${version}`, result: log.result('install', 'unchanged'), outcome: 'unchanged' };
  }
  const from = existing ? await installedSide(catalog, existing) : null;
  const flags = gate(from, to).risk_flags;
  const confirm = encode({ name: req.name, target, version, fingerprint: to.fingerprint, latest: v.latest });
  // Held over `entry` (none: a first install), with the flags from the gate against it, or undefined when it goes through.
  // Another version over an installed copy follows that skill's rows, as an update does (the owner's decision): another
  // catalog first, then pin, then notify, then the flags. The held result names the installed version.
  const heldOver = (entry: LockEntry | undefined, flags: readonly RiskFlag[]): Done | undefined => {
    const held = { name: req.name, target, version, confirm, flags: JSON.stringify(kinds(flags)), command: acceptCommand(s, req.name, target) };
    const reason = entry && (entry.catalog !== ctx.settings.catalog || entry.version !== version) ? holdOf(ctx, entry, config) : undefined;
    if (entry && reason) {
      recordHold(ctx, req.name, version, reason, flags, version - entry.version);
      const also = flags.length ? s.format(s.word('update.held_also'), { reasons: reasons(s, flags) }) : '';
      const text = s.format(w[ctx.face === 'cli' ? `held_${reason}_cli` : `held_${reason}`], { ...held, from: entry.version, also, was: entry.catalog, now: ctx.settings.catalog });
      return { text, target: `${req.name} v${version}`, result: log.result('install', `held_${reason}`), outcome: 'held' };
    }
    if (flags.length) {
      recordHold(ctx, req.name, version, 'flagged', flags, entry ? version - entry.version : 0);
      // Over an installed copy the sentence names the version installed now.
      const over = entry ? { word: 'held_over', from: entry.version } : { word: 'held' };
      const text = s.format(w[ctx.face === 'cli' ? `${over.word}_cli` : over.word], { ...held, ...over, reasons: reasons(s, flags) });
      return { text, target: `${req.name} v${version}`, result: log.result('install', 'held'), outcome: 'held' };
    }
    return undefined;
  };
  // Decided, held or written while this run holds the lock (§4.5): from the entry as it is now, since another run may
  // have pinned, moved, updated or removed it since it was read. The fresh decision stands, with the version already
  // fetched and checked; the flags are taken again against another installed version, read from the catalog.
  const done = await withLock(ctx.settings.home, clockOf(ctx), async (fresh): Promise<Done | { written: ReturnType<typeof writeSkill>; entry: LockEntry }> => {
    const now = fresh.skills[dest];
    if (!sameDecision(existing, now)) {
      if (now && now.catalog === ctx.settings.catalog && now.version >= version) {
        return { text: s.format(w.unchanged, { name: req.name, version: now.version }), target: `${req.name} v${now.version}`, result: log.result('install', 'unchanged'), outcome: 'unchanged' };
      }
      // Another catalog now is held as such with the flags already taken; they're taken again only against no copy, or
      // against another installed version, read from the catalog.
      const again = !now
        ? heldOver(undefined, gate(null, to).risk_flags)
        : heldOver(now, now.catalog !== ctx.settings.catalog || now.version === existing?.version ? flags : gate(await installedSide(catalog, now), to).risk_flags);
      if (again) return again;
    } else {
      const held = heldOver(existing, flags);
      if (held) return held;
    }
    const written = writeSkill(dest, target, to.files, now, standsIn(ctx, target));
    return { written, entry: record(ctx, fresh, dest, { name: req.name, target }, to, req.policy ?? now?.policy, now?.accepted ?? [], toLock(written.copy)) };
  });
  if (!('written' in done)) return done;
  const { written, entry } = done;
  const text = s.format(w.done, { name: req.name, version, path: quoted(dest), policy: policyWords(s, policyOf(entry, config)) }) + keptLine(s, req.name, written.kept) + '\n' + s.format(w.live, { name: req.name });
  return { text, target: `${req.name} v${version}`, result: log.result('install', 'installed'), outcome: 'installed' };
}

/** An update's line for a skill whose folder failed a check: the reason worded per code, else shown as its data. */
function refusedTarget(s: Words, at: { name: string; from: number; to: number }, err: CatalogError): string {
  // A folder that changed mid-write has its own line, not "nothing was written": the moved-aside copy kept in staging, the
  // temp folder that changed (nothing installed touched), or the copy back in place; and whether a copy may be elsewhere.
  if (err.code === 'target_changed') {
    const d = err.data;
    const w = s.word('update')[d['staging'] !== undefined ? 'target_changed_staging' : d['temp'] === true ? 'target_changed_temp' : 'target_changed'];
    const tail = d['elsewhere'] === true ? s.format(s.word('errors').target_changed_elsewhere) : '';
    return s.format(w, { ...at, ...d }) + tail;
  }
  const path = String(err.data['path']);
  const reason = s.word('update.target_reason')?.[err.code];
  // With nothing newer to apply, the version refused is the one installed: its own sentence says it's the latest.
  return s.format(s.word(at.from === at.to ? 'update.refused_target_current' : 'update.refused_target'), { ...at, path, reason: typeof reason === 'string' ? s.format(reason, { path }) : asData(err.code, err.data) });
}

/** The line naming where a replaced copy was kept (an entry recorded before identities were kept), or nothing. */
function keptLine(s: Words, name: string, kept: string | undefined): string {
  if (kept === undefined) return '';
  const w = s.word('update.kept_in_staging');
  return '\n' + (typeof w === 'string' ? s.format(w, { name, staging: kept }) : asData('kept_in_staging', { name, staging: kept }));
}

/** Why another version of an installed skill waits for the person, in the order of §5.3: a copy from another catalog
 *  (it may be a different skill that shares the name), then pin, then notify; undefined when only the flags decide. */
function holdOf(ctx: Context, e: LockEntry, config: Parameters<typeof policyOf>[1]): 'other_catalog' | 'pin' | 'notify' | undefined {
  if (e.catalog !== ctx.settings.catalog) return 'other_catalog';
  const { policy } = policyOf(e, config);
  return policy === 'pin' || policy === 'notify' ? policy : undefined;
}

/** A hold, for the usage metrics (§3): the held version, why, the kinds of flag and how many versions behind. */
function recordHold(ctx: Context, name: string, version: number, reason: HoldReason, flags: readonly RiskFlag[], behind: number): void {
  const hold: UsageEvent = { event: 'hold', skill: name, version, reason, flags: kinds(flags) as Extract<UsageEvent, { event: 'hold' }>['flags'], behind: Math.max(0, behind) };
  recordUsage(ctx.settings.home, hold, ctx.now(), { createKey: true });
}

/** The fingerprint of the files in an installed folder as they are on disk, or undefined when it can't be one (a link or
 *  anything but a file or folder inside, or more than a skill may hold): then the copy isn't intact. */
function folderFingerprint(dir: string): string | undefined {
  const entries: { path: string; mode: '0644' | '0755'; sha256: string }[] = [];
  let bytes = 0;
  const walk = (rel: string): boolean => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatOf(join(dir, r));
      if (!st) return false;
      if (st.isDirectory()) {
        if (!walk(r)) return false;
        continue;
      }
      if (!st.isFile() || entries.length >= DEFAULT_LIMITS.files || (bytes += Number(st.size)) > DEFAULT_LIMITS.skill_bytes) return false;
      entries.push({ path: r, mode: (st.mode & 0o111n) !== 0n ? '0755' : '0644', sha256: sha256Hex(readFileSync(join(dir, r))) });
    }
    return true;
  };
  try {
    const top = lstatOf(dir);
    return top?.isDirectory() && walk('') ? fingerprint(entries) : undefined;
  } catch {
    return undefined;
  }
}

/** An intact copy the person recreated (a restore, a branch switch): its identity is recorded again, only while the
 *  folders above it are the real, private ones and it's a real folder itself; nothing is moved. */
async function recordAgain(ctx: Context, dest: string, target: Target, e: LockEntry, write: <T>(fn: (lock: Lock) => T) => Promise<T> = (fn) => withLock(ctx.settings.home, clockOf(ctx), fn)): Promise<void> {
  const now = idOf(dest);
  if (now === undefined || same(now, fromLock(e.copy))) return;
  skillsFolderFor(dest, target, standsIn(ctx, target));
  if (!isCopy(lstatOf(dest), now)) return;
  // Only onto the entry this was decided from: another run may have installed, updated or recorded it since (§4.5).
  await write((fresh) => {
    const entry = fresh.skills[dest];
    if (entry && entry.version === e.version && entry.fingerprint === e.fingerprint && (entry.copy === undefined ? e.copy === undefined : same(fromLock(entry.copy), fromLock(e.copy)))) fresh.skills[dest] = { ...entry, copy: toLock(now) };
  });
}

/** The clock a wait for another run's lock is measured by. */
const clockOf = (ctx: Context) => () => ctx.now().getTime();

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
  return entry;
}

/** Whether a skill's lock entry, as read under the lock, is still the one a decision was made from (read before the lock):
 *  there or not, and the same catalog, version and policy. Another run may have pinned, moved, updated or removed it. */
const sameDecision = (was: LockEntry | undefined, now: LockEntry | undefined): boolean =>
  was === undefined || now === undefined ? was === now : was.catalog === now.catalog && was.version === now.version && was.policy === now.policy;

type AcceptInput = { name: string; target: Target; version: number; confirm: string; flags: string[] };

export async function accept(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<AcceptInput>('accept_held_update', args, ctx.face, 'local');
  const s = ctx.words;
  const { lock, config } = readRecords(ctx.settings.home);
  const t = decode(req.confirm);
  const conflict = () => new CatalogError('conflict', { name: req.name, held: true });
  // The name, target and version are in the input so the person's permission prompt shows them: each must be the hold's.
  if (t.name !== req.name || t.target !== req.target || t.version !== req.version) throw conflict();
  const catalog = await ctx.catalog();
  const v = await allVersions(catalog, req.name);
  if (v.latest !== t.latest) throw conflict();
  const dest = checkTarget(ctx, t.target, req.name, lock);
  const existing = lock.skills[dest];
  const to = await fetchListed(catalog, req.name, v, t.version);
  if (to.fingerprint !== t.fingerprint) throw conflict();
  const flags = gate(existing ? await installedSide(catalog, existing) : null, to).risk_flags;
  if (!sameSet(req.flags, kinds(flags))) throw conflict();
  const { written, entry } = await withLock(ctx.settings.home, clockOf(ctx), (fresh) => {
    const now = fresh.skills[dest];
    if (!sameDecision(existing, now)) throw conflict();
    const written = writeSkill(dest, t.target, to.files, now, standsIn(ctx, t.target));
    return { written, entry: record(ctx, fresh, dest, { name: req.name, target: t.target }, to, now?.policy, [...(now?.accepted ?? []), { version: to.version, flags: kinds(flags) }], toLock(written.copy)) };
  });
  // The person's yes, wherever it was given (§3's usage metrics).
  recordUsage(ctx.settings.home, { event: 'answer', skill: req.name, version: to.version, answer: 'yes', together: 1 }, ctx.now(), { createKey: true });
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
  const req = validateInput<UpdateInput>('update_installed_skills', args, ctx.face, 'local');
  const s = ctx.words;
  const w = s.word('update');
  const log = logWords(s);
  const { lock, config } = readRecords(ctx.settings.home);
  const here = installedHere(ctx, lock);
  for (const name of req.names ?? []) if (!here.some((e) => e.name === name)) throw new CatalogError('not_installed', { name });
  // Each sync counts, with the permissive mode Claude Code's settings turn on, if any (§5.3).
  recordUsage(ctx.settings.home, { event: 'mode', mode: permissiveMode(ctx.settings).mode ?? 'default', face: 'update' }, ctx.now());
  const chosen = req.names ? here.filter((e) => req.names!.includes(e.name)) : here;
  if (!chosen.length) {
    const none = s.word('update.none_installed');
    return { text: typeof none === 'string' ? s.format(none) : asData('update', { checked: 0 }), target: '-', result: log.result('update', 'unchanged'), outcome: 'unchanged' };
  }
  const catalog = await ctx.catalog();
  const lines: string[] = [];
  const targets: string[] = [];
  let unchanged = 0;
  // The same result as data, for a person's view (person/view.ts): one item per skill that did something or waits.
  const items: UpdateItem[] = [];
  const item = (kind: UpdateItem['kind'], at: { name: string; from: number; to: number }, flags: readonly RiskFlag[], ...said: string[]) => {
    lines.push(...said);
    items.push({ kind, ...at, flags: [...flags], lines: said });
  };
  // The log's one word for the call: the outcome that most needs the person (a refusal first, then a hold), else updated,
  // else up to date.
  const RANK = ['unchanged', 'updated', 'held_pin', 'held_notify', 'held_flagged', 'held_other_catalog', 'refused'];
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
  // The lock is taken at the first write and held to the end (§4.5), so lock_busy always means nothing was changed.
  const hold = holdLock(ctx.settings.home, clockOf(ctx));
  try {
    for (const e of chosen) {
      const v = await allVersions(catalog, e.name);
      // A name reserved since it was installed is refused at every update, up to date or not (§5.3 step 2).
      try {
        checkName(e.name);
      } catch (err) {
        if (!(err instanceof CatalogError)) throw err;
        item('refused', { name: e.name, from: e.version, to: v.latest }, [], s.format(w.refused, { name: e.name, from: e.version, to: v.latest, reason: refusalReason(s, err) }));
        refused(err.code);
        continue;
      }
      if (v.latest === e.version) {
        // Nothing newer: the folder is checked as an install checks it, so a link made since is refused, never up to date;
        // an intact copy the person recreated just has its identity recorded again. A failed check is refused at the
        // version installed.
        try {
          const here = checkTarget(ctx, e.target, e.name, lock);
          if (folderFingerprint(here) === e.fingerprint) await recordAgain(ctx, here, e.target, e, hold.change);
        } catch (err) {
          if (!(err instanceof CatalogError) || err.code === 'lock_busy') throw err;
          item('refused', { name: e.name, from: e.version, to: e.version }, [], refusedTarget(s, { name: e.name, from: e.version, to: e.version }, err));
          refused(err.code);
          continue;
        }
        unchanged++;
        continue;
      }
      const at = { name: e.name, from: e.version, to: v.latest };
      targets.push(`${e.name} v${e.version} → v${v.latest}`);
      // Where it goes, checked as an install checks it: a link or a same-name skill or command may have appeared since.
      let dest: string;
      try {
        dest = checkTarget(ctx, e.target, e.name, lock);
      } catch (err) {
        if (!(err instanceof CatalogError)) throw err;
        item('refused', at, [], refusedTarget(s, at, err));
        refused(err.code);
        continue;
      }
      let to: Side;
      try {
        to = await fetchListed(catalog, e.name, v, v.latest);
      } catch (err) {
        if (!(err instanceof CatalogError)) throw err;
        const refusedFingerprint = s.word('update.refused_fingerprint');
        item('refused', at, [],
          err.code === 'fingerprint_mismatch'
            ? typeof refusedFingerprint === 'string' ? s.format(refusedFingerprint, at) : asData('refused', { ...at, error: err.toJSON() })
            : s.format(w.refused, { ...at, reason: refusalReason(s, err) }),
        );
        refused(err.code);
        continue;
      }
      const d = gate(await installedSide(catalog, e), to);
      const confirm = encode({ name: e.name, target: e.target, version: to.version, fingerprint: to.fingerprint, latest: v.latest });
      // Held over `entry`, with `d` the gate against it: its lines are written and true is returned; false when it goes on.
      const heldOver = (entry: LockEntry, d: TreeDiff): boolean => {
        const at = { name: e.name, from: entry.version, to: v.latest };
        const take = { ...at, target: e.target, confirm, flags: JSON.stringify(kinds(d.risk_flags)) };
        const also = d.risk_flags.length ? s.format(w.held_also, { reasons: reasons(s, d.risk_flags) }) : '';
        const { policy } = policyOf(entry, config);
        // A copy from another catalog comes first (§5.3): it may be a different skill that shares the name. Never applied
        // silently; taken on a yes, which records the catalog in use.
        if (entry.catalog !== ctx.settings.catalog) {
          recordHold(ctx, e.name, to.version, 'other_catalog', d.risk_flags, to.version - entry.version);
          item('held_other_catalog', at, d.risk_flags, s.format(w.held_other_catalog, { ...at, was: entry.catalog, now: ctx.settings.catalog, also }), s.format(ctx.face === 'cli' ? w.held_notify_next_cli : w.held_notify_next, take));
          saw('held_other_catalog');
          return true;
        }
        // Pinned: stays, and the person may still take this version; it stays pinned, at that version.
        if (policy === 'pin') {
          recordHold(ctx, e.name, to.version, 'pin', d.risk_flags, to.version - entry.version);
          item('held_pin', at, d.risk_flags, s.format(w.held_pin, at), s.format(ctx.face === 'cli' ? w.held_pin_next_cli : w.held_pin_next, take));
          saw('held_pin');
          return true;
        }
        // "Tell me first" holds every new version, flagged or not (§5.3: pin, then notify, then the flags); it's taken with
        // the flags it shows, [] when none.
        if (policy === 'notify') {
          recordHold(ctx, e.name, to.version, 'notify', d.risk_flags, to.version - entry.version);
          item('held_notify', at, d.risk_flags, d.risk_flags.length ? s.format(w.held_notify_flagged, { ...at, reasons: reasons(s, d.risk_flags) }) : s.format(w.held_notify, at), s.format(ctx.face === 'cli' ? w.held_notify_next_cli : w.held_notify_next, take));
          saw('held_notify');
          return true;
        }
        // accept_flagged_updates (only ever `true` from the person's own setup) lets a flagged update through, never an
        // install; the lock records each one it let through (§5.3).
        if (d.risk_flags.length && config.accept_flagged_updates !== true) {
          recordHold(ctx, e.name, to.version, 'flagged', d.risk_flags, to.version - entry.version);
          item('held_flagged', at, d.risk_flags, s.format(w.held_flagged, { ...at, reasons: reasons(s, d.risk_flags) }), s.format(ctx.face === 'cli' ? w.held_next_cli : w.held_next, take));
          saw('held_flagged');
          return true;
        }
        return false;
      };
      // A dry run writes nothing and takes no lock: it says what this read would do.
      if (req.dry_run) {
        if (!heldOver(e, d)) item('would_update', at, d.risk_flags, s.format(w.would_update, { ...at, changes: changesOf(s, d) }));
        continue;
      }
      // A folder that changed while it was being written is that skill's refused line; the other skills go on.
      // Another run holding the lock past the wait refuses the whole call (lock_busy).
      // Held or written under the lock, decided from the entry as it is now (§4.5): another run may have pinned, moved,
      // updated or removed it since it was read. The fresh decision stands, with the version already fetched and checked;
      // the flags are taken again against another installed version, read from the catalog.
      let done: { written: ReturnType<typeof writeSkill>; from: number; d: TreeDiff } | 'held' | 'unchanged' | 'removed';
      try {
        done = await hold.change(async (fresh) => {
          const now = fresh.skills[dest];
          let dNow = d;
          if (!sameDecision(e, now)) {
            if (!now) return 'removed';
            if (now.catalog === ctx.settings.catalog && now.version >= to.version) return 'unchanged';
            // Another catalog now is held as such with the flags already taken; they're taken again only against another
            // installed version, read from the catalog.
            if (now.catalog === ctx.settings.catalog && now.version !== e.version) dNow = gate(await installedSide(catalog, now), to);
          }
          const entry = now ?? e;
          if (heldOver(entry, dNow)) return 'held';
          const w = writeSkill(dest, e.target, to.files, entry, standsIn(ctx, e.target));
          const accepted = dNow.risk_flags.length ? [...entry.accepted, { version: to.version, flags: kinds(dNow.risk_flags), by: 'accept_flagged_updates' as const }] : entry.accepted;
          record(ctx, fresh, dest, entry, to, entry.policy, accepted, toLock(w.copy));
          return { written: w, from: entry.version, d: dNow };
        });
      } catch (err) {
        if (!(err instanceof CatalogError) || err.code === 'lock_busy') throw err;
        item('refused', at, [], refusedTarget(s, at, err));
        refused(err.code);
        continue;
      }
      if (done === 'held') continue;
      if (done === 'unchanged' || done === 'removed') {
        targets.pop();
        if (done === 'unchanged') unchanged++;
        // Removed meanwhile: no longer installed, so left out of an update of every skill; named, it's not_installed.
        else if (req.names) {
          item('refused', at, [], s.format(w.refused, { ...at, reason: refusalReason(s, new CatalogError('not_installed', { name: e.name })) }));
          refused('not_installed');
        }
        continue;
      }
      item('updated', { ...at, from: done.from }, done.d.risk_flags, s.format(w.updated, { ...at, from: done.from, changes: changesOf(s, done.d) }) + keptLine(s, e.name, done.written.kept));
      saw('updated');
    }
  } finally {
    hold.release();
  }
  if (unchanged) lines.push(s.format(w.unchanged, { n: unchanged }));
  const text = [s.format(w.header, { checked: chosen.length }), ...lines].join('\n');
  const view: UpdateView = { kind: 'update', checked: chosen.length, unchanged, dry_run: req.dry_run === true, items };
  return { text, target: targets.join(', ') || '-', result: outcome === 'refused' ? log.error(refusal!) : log.result('update', outcome), outcome, view };
}

export async function list(ctx: Context): Promise<Done> {
  const s = ctx.words;
  const { lock, config } = readRecords(ctx.settings.home);
  const here = installedHere(ctx, lock);
  const catalog = here.length ? await ctx.catalog() : undefined;
  const rows = [];
  for (const e of here) {
    const latest = (await catalog!.versions({ name: e.name })).latest;
    rows.push({ name: e.name, target: e.target, version: e.version, latest, policy: policyOf(e, config), state: latest === e.version ? ('same' as const) : ('behind' as const) });
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
  const view: ListView = { kind: 'list', rows: rows.map((r) => ({ ...r, policy: r.policy.policy, policy_words: policyWords(s, r.policy) })) };
  return { text, target: rows.map((r) => `${r.name} v${r.version}`).join(', ') || '-', result: logWords(s).result('status'), view };
}

type PolicyInput = { policy: Policy; name?: string };

export async function setPolicy(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<PolicyInput>('set_skill_update_policy', args, ctx.face, 'local');
  const s = ctx.words;
  const home = ctx.settings.home;
  const w = s.word('policy_set');
  const name = s.word('policy_name')?.[req.policy] ?? req.policy;
  const { lock, config } = readRecords(home);
  const near_hold = holdWithinADay(home, ctx.now());
  if (req.name === undefined) {
    writeConfig(home, { ...config, update_policy: req.policy });
    recordUsage(home, { event: 'policy', from: config.update_policy ?? policyOf(undefined, config).policy, to: req.policy, scope: 'catalog', near_hold }, ctx.now());
    return { text: w ? s.format(w.default, { policy: name }) : asData('set_skill_update_policy', { policy: req.policy }), target: '-', result: logWords(s).result('policy') };
  }
  const entries = installedHere(ctx, lock).filter((e) => e.name === req.name);
  if (!entries.length) throw new CatalogError('not_installed', { name: req.name });
  // A pin set while an update waits for the person is their answer to it (§3's usage metrics), taken before it changes.
  const waiting = req.policy === 'pin' ? await pendingHold(ctx, req.name).catch(() => null) : null;
  await withLock(home, clockOf(ctx), (fresh) => {
    for (const e of entries) {
      const key = destOf(ctx, e.target, e.name);
      const now = fresh.skills[key];
      if (now) fresh.skills[key] = { ...now, policy: req.policy };
    }
  });
  recordUsage(home, { event: 'policy', from: policyOf(entries[0], config).policy, to: req.policy, scope: 'skill', near_hold }, ctx.now());
  if (waiting && 'confirm' in waiting) recordUsage(home, { event: 'answer', skill: req.name, version: waiting.version, answer: 'pin', together: 1 }, ctx.now(), { createKey: true });
  return { text: w ? s.format(w.skill, { name: req.name, policy: name }) : asData('set_skill_update_policy', { name: req.name, policy: req.policy }), target: req.name, result: logWords(s).result('policy') };
}
