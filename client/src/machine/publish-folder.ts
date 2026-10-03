// publish_skill_to_catalog (contract §3): a skill folder on this machine becomes a new version in the shared catalog, in
// two steps, so the person sees what will be published before it is. Step 1 (no confirm) reads the folder, runs the
// core's own checks as a dry run (the owner, the manifest, the files, the secret scan: nothing is stored) and lists what
// it would send and skip, with the values step 2 repeats: the name, the version it would become, how many files and the
// flags' kinds, so the person's permission prompt for step 2 shows what they agree to. Its confirm is an HMAC over the
// folder's real path, its fingerprint, those values and the message, keyed with a secret only this machine holds. Step 2
// checks, in order: the confirm's form; the HMAC over the folder read again and step 2's own values (any difference is a
// conflict naming the folder); the catalog's latest (a version published in between is the core's own conflict); then
// the publish's usual checks. The confirm is never an authority: step 2 checks everything again.
//
// The folder is read as regular files only: a link (in or out), a hard link or a special file is invalid_path, and its
// target is never read. The ignore list (.git, .env*, *.pem, id_*, .DS_Store), files and folders alike, at any depth, is
// skipped and reported by name, never read or walked.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, validateInput, type PublishResult } from '@skills-catalog/core';
import { DEFAULT_LIMITS, checkManifest, checkTree, fingerprint, flagText, sha256Hex, type Mode, type RiskFlag } from '@skills-catalog/core/skill-tree';
import { logWords } from '../activity.ts';
import type { Context, Done } from '../operations.ts';

type Input = {
  folder: string; message?: string; confirm?: string; name?: string; version?: number; files?: number; flags?: string[];
  allow_suspected_secrets?: boolean;
};
// What step 2 repeats from step 1, in the order a missing one is named.
const STEP2 = ['name', 'version', 'files', 'flags'] as const;
// Skipped entries shown, then how many more (contract §3).
/** What a person reads about a publish (review V3.2): the preview's files, sent and skipped, and anything worth a look; or
 *  what was published. */
/** A publish as data for a person's view. A preview also carries the words file's fields and the step-2 values, for the
 *  CLI's own preview and its step-2 command (cli/commands/publish.ts). */
export type PublishView = {
  kind: 'publish'; stage: 'preview' | 'published'; name: string; version: number; latest: number; send: string[]; skipped: string[]; changed: string[]; notes: string[];
  fields?: Record<string, unknown>;
  step2?: { folder: string; confirm: string; name: string; version: number; files: number; flags: string[]; message: string | null };
};

export const SKIPPED_SHOWN = 50;
// `why` names each skipped path's reason; `modes` each sent file whose mode isn't one the catalog keeps (review P2.3,
// P2.4, P8.4, P8.5).
type Folder = { files: { path: string; mode: Mode; bytes: Buffer }[]; skipped: string[]; why: Record<string, SkipWhy>; modes: Record<string, string> };
export type SkipWhy = 'git' | 'system' | 'env' | 'key' | 'empty';

const quoted = (p: string) => JSON.stringify(p);
const list = (xs: readonly string[]) => xs.join(', ');

// The ignore list, by name at any depth, files and folders alike: what the person keeps next to a skill and never means
// to publish, with its reason. Narrow on purpose (review P2.3): .env, .env.* and .envrc, not every name starting .env
// (.envrc-notes.md is notes); id_* only with no extension or as .pub (id_rsa, id_ed25519.pub), not id_mapping.md.
function ignored(name: string): SkipWhy | undefined {
  if (name.toLowerCase() === '.git') return 'git';
  if (name === '.DS_Store') return 'system';
  if (name === '.env' || name === '.envrc' || (name.startsWith('.env.') && !/\.(md|markdown|txt)$/i.test(name))) return 'env';
  if (name.endsWith('.pem') || /^id_[^.]+(\.pub)?$/.test(name)) return 'key';
  return undefined;
}
// Paths in code-point order (UTF-8 bytes sort that way).
const byCodePoint = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function notRegular(path: string): never {
  throw new CatalogError('invalid_path', { path, why: 'not_regular_file' });
}

/** Test hooks, to swap something between a check and what it guards. */
export type ReadHooks = { beforeRead?: (full: string) => void; beforeList?: (dir: string) => void };

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

// One checked file's bytes, only from the file that was checked (contract §4.2, "its target is never read"): opened
// without following a link or waiting on a fifo, then the handle must be a regular file with one link and the same
// device and inode as the check, within the size limit. What is read is what the handle holds.
function readChecked(full: string, rel: string, checked: Stats, maxBytes: number): Buffer {
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    notRegular(rel);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || !same(st, checked)) notRegular(rel);
    if (st.size > maxBytes) throw new CatalogError('too_large', { limit: 'file_bytes', max: maxBytes, value: st.size, path: rel });
    const bytes = Buffer.alloc(st.size);
    let n = 0;
    for (let got = 1; n < st.size && got > 0; n += got) got = readSync(fd, bytes, n, st.size - n, n);
    return bytes.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// The folder's files, with a size check before any byte is read (the core's limits refuse the rest).
export function readFolder(root: string, hooks: ReadHooks = {}): Folder {
  let top: Stats;
  try {
    top = lstatSync(root);
  } catch {
    throw new CatalogError('invalid_manifest', { problem: 'missing', fields: ['SKILL.md'] });
  }
  if (!top.isDirectory()) throw new CatalogError('invalid_manifest', { problem: 'missing', fields: ['SKILL.md'] });
  const found: { path: string; full: string; st: Stats }[] = [];
  const skipped: string[] = [];
  const why: Record<string, SkipWhy> = {};
  const modes: Record<string, string> = {};
  // A folder is listed only if it is still the folder that was checked once listed: a link swapped in is refused
  // before anything it listed is used.
  const walk = (dir: string, rel: string, checked: Stats) => {
    hooks.beforeList?.(dir);
    const entries = readdirSync(dir, { withFileTypes: true });
    const now = lstatSync(dir);
    if (!now.isDirectory() || !same(now, checked)) notRegular(rel || '.');
    for (const e of entries.sort((a, b) => byCodePoint(a.name, b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      const st = lstatSync(full);
      const reason = ignored(e.name);
      if (reason) {
        const shown = st.isDirectory() ? `${r}/` : r; // a folder is one entry, never walked
        skipped.push(shown);
        why[shown] = reason;
        continue;
      }
      if (st.isSymbolicLink()) notRegular(r);
      if (st.isDirectory()) {
        // An empty folder isn't stored (a skill is its files): said, not silently dropped.
        if (readdirSync(full).length === 0) {
          skipped.push(`${r}/`);
          why[`${r}/`] = 'empty';
          continue;
        }
        walk(full, r, st);
      }
      else if (st.isFile()) {
        if (st.nlink > 1) notRegular(r); // a hard link may be another file's bytes, outside this folder
        else found.push({ path: r, full, st });
      } else notRegular(r);
    }
  };
  walk(root, '', top);
  const limits = DEFAULT_LIMITS;
  if (found.length > limits.files) throw new CatalogError('too_large', { limit: 'files', max: limits.files, value: found.length });
  let total = 0;
  for (const f of found) {
    if (f.st.size > limits.file_bytes) throw new CatalogError('too_large', { limit: 'file_bytes', max: limits.file_bytes, value: f.st.size, path: f.path });
    total += f.st.size;
  }
  if (total > limits.skill_bytes) throw new CatalogError('too_large', { limit: 'skill_bytes', max: limits.skill_bytes, value: total });
  const files = found.map((f) => {
    hooks.beforeRead?.(f.full);
    const mode = (f.st.mode & 0o111 ? '0755' : '0644') as Mode;
    // The catalog keeps two modes (contract §4.2; the fingerprint holds them): another one is named, not silently changed.
    const had = '0' + (f.st.mode & 0o777).toString(8);
    if (had !== mode) modes[f.path] = had;
    return { path: f.path, mode, bytes: readChecked(f.full, f.path, f.st, limits.file_bytes) };
  });
  return { files, skipped: skipped.sort(byCodePoint), why, modes };
}

// The secret the confirm is keyed with: $SKILLS_HOME/confirm.key, 32 random bytes, 0600, made on first use. One that
// isn't a regular file of 32 bytes with mode 0600 owned by this user (a link, a wider mode) is replaced before use, never
// followed or written through, so every earlier confirm stops verifying.
const KEY_BYTES = 32;
const goodKey = (st: Stats) => st.isFile() && st.nlink === 1 && (st.mode & 0o777) === 0o600 && st.uid === process.getuid?.() && st.size === KEY_BYTES;
export function confirmKey(home: string): Buffer {
  const path = join(home, 'confirm.key');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const key = Buffer.alloc(KEY_BYTES);
    if (goodKey(fstatSync(fd)) && readSync(fd, key, 0, KEY_BYTES, 0) === KEY_BYTES) return key;
  } catch {
    // missing, or a link in its place: made anew below
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const tmp = join(home, `.confirm.key.${process.pid}.${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(tmp, path); // where there was none: two servers starting at once agree on whichever landed first
    unlinkSync(tmp);
    return key;
  } catch {
    // one is there: a good one (another server's, just made) is used; anything else is replaced
  }
  let good = false;
  try {
    good = goodKey(lstatSync(path));
  } catch {
    // gone again: replaced below
  }
  if (good) {
    unlinkSync(tmp);
    return confirmKey(home);
  }
  renameSync(tmp, path); // replaces a link or a looser file in one step, never through it
  return key;
}

// What a confirm binds, in one unambiguous encoding, the flags as a set of kinds.
type Bound = { folder: string; fingerprint: string; name: string; latest: number; message: string | null; files: number; flags: readonly string[] };
const kinds = (flags: readonly string[]) => [...new Set(flags)].sort(byCodePoint);
const mac = (key: Buffer, b: Bound) =>
  createHmac('sha256', key).update(JSON.stringify([b.folder, b.fingerprint, b.name, b.latest, b.message, b.files, kinds(b.flags)])).digest();
const CONFIRM_FORM = /^[A-Za-z0-9_-]{43}$/;

// A refusal about the folder's own content names the folder, so its sentence can say where to fix it.
function inFolder(e: unknown, folder: string): unknown {
  if (e instanceof CatalogError && ['invalid_manifest', 'invalid_name', 'invalid_path', 'secret_suspected', 'too_large'].includes(e.code)) {
    return new CatalogError(e.code, { ...e.data, folder });
  }
  return e;
}

export async function publishFolder(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<Input>('publish_skill_to_catalog', args, ctx.face, 'local');
  if (req.confirm === undefined) {
    if (STEP2.some((k) => req[k] !== undefined)) throw new CatalogError('invalid_request', { field: 'confirm', why: 'required' });
  } else {
    const missing = STEP2.find((k) => req[k] === undefined);
    if (missing) throw new CatalogError('invalid_request', { field: missing, why: 'required' });
    if (!CONFIRM_FORM.test(req.confirm)) throw new CatalogError('invalid_request', { field: 'confirm', why: 'not_a_confirm' });
  }
  const s = ctx.words;
  const w = s.word('publish');
  const log = logWords(s);
  let real = req.folder;
  try {
    const { files, skipped, why, modes } = readFolder(req.folder);
    real = realpathSync(req.folder); // what the confirm binds and a refusal names: links in the path resolved
    const tree = checkTree(files);
    const name = checkManifest(tree).name;
    const fp = fingerprint(files.map((f) => ({ path: f.path, mode: f.mode, sha256: sha256Hex(f.bytes) })));
    const catalog = await ctx.catalog();
    const input = {
      name,
      files: files.map((f) => ({ path: f.path, mode: f.mode, content_base64: f.bytes.toString('base64') })),
      ...(req.message !== undefined ? { message: req.message } : {}),
      ...(req.allow_suspected_secrets ? { allow_suspected_secrets: true } : {}),
    };

    const key = confirmKey(ctx.settings.home);
    const message = req.message ?? null;

    if (req.confirm === undefined) {
      // A dry run creates nothing: the same bytes as the latest come back as that version with nothing changed; anything
      // else as the version it would become.
      const r: PublishResult = await catalog.publish({ ...input, dry_run: true }, undefined, ctx.face);
      const identical = r.diff_from_latest !== null && r.diff_from_latest.files.length === 0;
      const latest = identical ? r.version : r.version - 1;
      if (identical) return { text: s.format(w.identical, { folder: quoted(req.folder), name, latest }), target: `${name} v${latest}`, result: log.result('publish', 'identical') };
      const flags = kinds(r.risk_flags.map((f: RiskFlag) => f.kind));
      const confirm = mac(key, { folder: real, fingerprint: fp, name, latest, message, files: files.length, flags }).toString('base64url');
      const shown = skipped.slice(0, SKIPPED_SHOWN).map((p) => (why[p] ? `${quoted(flagText(p))} (${w.skip_why[why[p]!]})` : quoted(flagText(p))));
      const changed = (r.diff_from_latest?.files ?? []).map((f) => quoted(f.path));
      const notes = r.risk_flags.map((f: RiskFlag) => s.format(s.word('quality.note')[f.kind], { path: flagText(f.path ?? ''), detail: flagText(f.detail) }));
      const fields = {
        name,
        version: r.version,
        change: latest === 0 ? w.new_skill : s.format(w.change_from, { latest, files: list(changed) }),
        n_send: files.length,
        // What changes on the way is named: a mode the catalog doesn't keep, a name stored in its composed (NFC) form.
        send: list(
          files.map((f) => {
            const notes = [...(modes[f.path] ? [s.format(w.mode_note, { from: modes[f.path], to: f.mode })] : []), ...(f.path.normalize('NFC') !== f.path ? [s.format(w.nfc_note, { path: quoted(f.path.normalize('NFC')) })] : [])];
            return notes.length ? `${quoted(f.path)} (${notes.join('; ')})` : quoted(f.path);
          }),
        ),
        n_skip: skipped.length,
        skip: shown.length ? list(shown) + (skipped.length > shown.length ? s.format(w.skip_more, { n: skipped.length - shown.length }) : '') : w.skip_none,
        review: notes.length ? s.format(w.review, { notes: notes.join('; ') }) : '',
        folder: quoted(req.folder),
        confirm,
        flags: JSON.stringify(flags),
        // The message is part of what the confirm binds: say it, or that there is none, so an assistant adds nothing.
        message_part: message === null ? w.no_message : s.format(w.with_message, { message: JSON.stringify(message) }),
      };
      const text = s.format(w.preview, fields);
      // The same preview as data: the person's view (person/view.ts), and the CLI's step-2 command (cli/commands/publish.ts).
      const view: PublishView = {
        kind: 'publish', stage: 'preview', name, version: r.version, latest, send: files.map((f) => f.path), skipped: [...skipped], changed: (r.diff_from_latest?.files ?? []).map((f) => f.path), notes,
        fields, step2: { folder: real, confirm, name, version: r.version, files: files.length, flags, message },
      };
      return { text, target: `${name} v${r.version}`, result: log.result('publish', 'preview'), view };
    }

    // Step 2: the folder as it is now and step 2's own values must be what step 1 showed; then the catalog's latest.
    const bound = { folder: real, fingerprint: fp, name: req.name!, latest: req.version! - 1, message, files: req.files!, flags: req.flags! };
    const given = Buffer.from(req.confirm, 'base64url');
    const expected = mac(key, bound);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new CatalogError('conflict', { name, folder: real });
    const r = await catalog.publish({ ...input, expected_latest: bound.latest }, undefined, ctx.face);
    const view: PublishView = { kind: 'publish', stage: 'published', name, version: r.version, latest: bound.latest, send: [], skipped: [], changed: [], notes: [] };
    return { text: s.format(w.published, { name, version: r.version }), target: `${name} v${r.version}`, result: log.result('publish', 'published'), view };
  } catch (e) {
    throw inFolder(e, real);
  }
}
