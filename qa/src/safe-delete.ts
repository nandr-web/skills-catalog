// The only code in qa that deletes anything (the QA plan §6.5a, added after the QA tools failed a security review).
//  - Run folders: only inside one base directory, `<tmp>/skills-catalog-qa`, checked with lstat every time: a real
//    directory (not a link), owned by the current user, mode 0700, whose real path is the path given, compared
//    case-sensitively. If the base fails a check, nothing is deleted and the caller stops.
//  - A run folder is named by a run id and must be a real directory directly in the base.
//  - Outside the base: one exact name in one expected parent, which must itself be a real directory at its real path.
//  - No link is followed: a link is removed, never its target (fs.rm removes links inside a folder, never their targets).
//  - A test process (vitest) that asks to create or delete anything under the real home, the real Claude tmp folder or
//    the real base fails before anything is looked at.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { platform, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

export const BASE_NAME = 'skills-catalog-qa';
export const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class UnsafeError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeError'; }
}

/** The real home, from the OS user record: `HOME` can point anywhere, this can't. */
export const realHome = () => userInfo().homedir;
export const realClaudeTmp = () => join(realpathSync.native('/tmp'), `claude-${userInfo().uid}`);
/** A test process: vitest marks its workers, and the children they start inherit the mark. */
export const inTestProcess = () => !!process.env.VITEST;

/** A path's real location, with the on-disk case (realpath.native), even if its last parts don't exist yet. */
export function canonical(path: string): string {
  let head = path;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  return join(realpathSync.native(head), ...tail);
}

/** `p` is `dir` or inside it. On macOS, whose disks ignore case by default, case is ignored too: the check that refuses. */
export function within(p: string, dir: string): boolean {
  const fold = (s: string) => (platform() === 'darwin' ? s.toLowerCase() : s);
  const a = fold(p), b = fold(dir).replace(/\/+$/, '');
  return a === b || a.startsWith(b + sep);
}

/** In a test process, refuse to create or delete anything under the real places (the QA plan §6.5a). */
export function tripwire(path: string, what: 'create' | 'delete' = 'delete'): void {
  if (!inTestProcess()) return;
  const p = canonical(path);
  for (const real of [realHome(), realClaudeTmp(), join(canonical(tmpdir()), BASE_NAME)]) {
    if (within(p, canonical(real))) throw new UnsafeError(`test tripwire: a test process asked to ${what} ${p}, under the real ${real} (the QA plan §6.5a); nothing done`);
  }
}

const oct = (mode: number) => '0' + (mode & 0o777).toString(8);

/** The base directory's checks. Throws, deleting nothing, when one fails. */
export function verifyBase(base: string): void {
  let st;
  try { st = lstatSync(base); } catch { throw new UnsafeError(`${base} doesn't exist: nothing deleted`); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafeError(`${base} is not a real directory (a link is never followed): nothing deleted`);
  if (st.uid !== process.getuid!()) throw new UnsafeError(`${base} belongs to another user (uid ${st.uid}): nothing deleted`);
  if ((st.mode & 0o777) !== 0o700) throw new UnsafeError(`${base} has mode ${oct(st.mode)}, not 0700: nothing deleted. If it's your qa folder, \`chmod 700 ${base}\` and run again`);
  const real = realpathSync.native(base);
  if (real !== base) throw new UnsafeError(`${base}: its real path is ${real} (compared case-sensitively): nothing deleted`);
}

/** Create the base (0700) if it's missing, then check it. */
export function ensureBase(base: string): void {
  tripwire(base, 'create');
  if (!existsSync(base) && !isLink(base)) mkdirSync(base, { mode: 0o700 });
  verifyBase(base);
}
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** The entry `name` in `parent`, exactly (case included): a disk that ignores case would find a look-alike too. */
const listed = (parent: string, name: string) => readdirSync(parent).includes(name);

export type RemoveOptions = { dryRun?: boolean };

/** Delete one run folder: `name` is a run id, and a real directory directly in the checked base. Returns its path. */
export function removeRun(base: string, name: string, o: RemoveOptions = {}): string {
  const p = join(base, name);
  tripwire(p);
  if (!RUN_ID.test(name)) throw new UnsafeError(`${p}: not a run id`);
  verifyBase(base);
  if (!listed(base, name)) throw new UnsafeError(`${p}: not in ${base} under this exact name (case included)`);
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafeError(`${p}: not a real directory (a link is never followed)`);
  if (realpathSync.native(p) !== p) throw new UnsafeError(`${p}: its real path is elsewhere`);
  if (!o.dryRun) rmSync(p, { recursive: true });
  return p;
}

export type LeftoverOptions = RemoveOptions & {
  /** With both: `name` must be under the base's prefix, belong to no other run in the base, and be named after `runRoot`. */
  base?: string; runRoot?: string;
};

/** Delete one leftover outside the base: exactly `name` in `parent`, which must be a real directory at its real path. A
 *  link is unlinked, never followed. Returns the path, or undefined when there's nothing there. */
export function removeLeftover(parent: string, name: string, o: LeftoverOptions = {}): string | undefined {
  const p = join(parent, name);
  tripwire(p);
  if (!name || name === '.' || name === '..' || name.includes('/')) throw new UnsafeError(`${JSON.stringify(name)}: not a single folder name`);
  let pst;
  try { pst = lstatSync(parent); } catch { return undefined; }
  if (pst.isSymbolicLink() || !pst.isDirectory()) throw new UnsafeError(`${parent}: the parent is not a real directory (a link is never followed)`);
  if (realpathSync.native(parent) !== parent) throw new UnsafeError(`${parent}: the parent's real path is ${realpathSync.native(parent)}`);
  if (o.base && o.runRoot) {
    const prefix = slug(o.base) + '-';
    const owns = (root: string) => name === slug(root) || name.startsWith(slug(root) + '-');
    if (!name.startsWith(prefix)) throw new UnsafeError(`${p}: not under the base's prefix ${prefix}`);
    const others = existsSync(o.base) ? readdirSync(o.base).filter((n) => RUN_ID.test(n)).map((n) => join(o.base!, n)).filter((r) => r !== o.runRoot) : [];
    if (others.some(owns)) throw new UnsafeError(`${p}: the same name belongs to another run`);
    if (!owns(o.runRoot)) throw new UnsafeError(`${p}: not named after ${o.runRoot}`);
  }
  let st;
  try { st = lstatSync(p); } catch { return undefined; }
  if (!listed(parent, name)) throw new UnsafeError(`${p}: only a name that differs in case is there; not deleted`);
  if (!o.dryRun) { if (st.isSymbolicLink()) unlinkSync(p); else rmSync(p, { recursive: true }); }
  return p;
}

/** A path as Claude Code names its folders: every character but a letter or a digit becomes "-" (`/`, `.` and `_` alike). */
export const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');
