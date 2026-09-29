// Setup's run (setup build notes §3 "Order of a run", §4): everything read and checked first (setup-plan), and only the
// skills home made before the lock (the lock lives in it). Then under setup.lock, planned afresh: config.json; the
// record, each entry of a file that changes listed as pending; per file, its backup then the file, then the record again
// with that file's entries written (a crash leaves a record that names at most more than was written, never less). A file
// another writer changed between the read and the place is read, merged and written again, up to 3 times in all. Two
// backups of each file are kept; the skills home and backups/ each get a .gitignore of `*`; this runner's own temp files
// left in the assistant's folders over an hour ago are removed.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CatalogError } from '@skills-catalog/core';
import { readJsonFile } from './json-file.ts';
import { folderId, writeFileText } from './json-write.ts';
import { readConfig, withLockFile, writeConfig, type Config } from './lock.ts';
import { isPrivate } from './private.ts';
import { planFile, planSetup, type FileKind, type FilePlan, type PlanInput, type SetupPlan } from './setup-plan.ts';
import { RECORD_CAP } from './setup-places.ts';
import type { RecordEntry, SetupRecord } from './setup-record.ts';

export type RunInput = PlanInput & {
  /** config.json as the person's answers make it. */
  config: Config;
  /** The clock: backups' names, the lock's wait and the sweep's age. */
  now: () => number;
  /** Test seams: after a file is read (before its backup and write), and after it's written and recorded. */
  seams?: { afterRead?: (path: string, attempt: number) => void; afterWrite?: (path: string) => void };
};
export type SetupResult = { plan: SetupPlan; written: string[]; backups: string[] };

const KINDS: readonly FileKind[] = ['claudeJson', 'settingsJson'];
const BACKUP_SUFFIX: Record<FileKind, string> = { claudeJson: 'claude.json', settingsJson: 'settings.json' };
const TRIES = 3;
const STALE_TEMP_MS = 60 * 60 * 1000;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
// An identity part as the record keeps it (the lock's rule): a number while it's a safe integer, its decimal past that.
const part = (n: bigint) => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString());

const lstatOr = (path: string): BigIntStats | undefined => {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
};

/** A folder made 0700 whatever the umask, set through a handle that doesn't follow a link; one there already must be a
 *  real, private folder. */
function makeFolder(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const s = lstatOr(path);
    if (!s || s.isSymbolicLink()) throw new CatalogError('target_symlink', { path });
    if (!s.isDirectory() || !isPrivate(s)) throw new CatalogError('target_not_private', { path, own: s.uid === BigInt(process.getuid?.() ?? -1) });
  }
}

/** A new file of setup's own, made only where nothing stands (never through a link), 0600, synced; its identity. */
function writeNew(path: string, bytes: Buffer | string): BigIntStats {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    for (let at = 0; at < b.length; ) at += writeSync(fd, b, at);
    fsyncSync(fd);
    return fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
}

type Backup = SetupRecord['backups'][number];

/** Removes a file of setup's own only while it's the one recorded: this user's regular file, the same identity and bytes
 *  (§4.5's removal rule). Anything else is left and never read further. */
function removeOwn(b: Backup): boolean {
  const s = lstatOr(b.path);
  if (!s || !s.isFile() || s.uid !== BigInt(process.getuid?.() ?? -1)) return false;
  if (String(part(s.dev)) !== String(b.dev) || String(part(s.ino)) !== String(b.ino)) return false;
  if (sha256(readFileSync(b.path)) !== b.sha256) return false;
  unlinkSync(b.path);
  return true;
}

export async function runSetup(input: RunInput): Promise<SetupResult> {
  const first = planSetup(input);
  if (first.missing.skillsHome) makeFolder(first.places.skillsHome);
  return withLockFile(first.places.lock, input.now, () => underLock(input));
}

function underLock(input: RunInput): SetupResult {
  const plan = planSetup(input);
  const { places } = plan;
  const H = places.skillsHome;
  const utc = new Date(input.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  if (JSON.stringify(readConfig(H)) !== JSON.stringify(input.config)) writeConfig(H, input.config);

  const changing = KINDS.filter((k) => plan.files[k].text !== undefined);
  const record: SetupRecord = {
    version: 1,
    setup_id: plan.id,
    entries: [],
    created_files: [...(plan.record?.created_files ?? [])],
    backups: [...(plan.record?.backups ?? [])],
  };
  const files: Record<FileKind, FilePlan> = { ...plan.files };
  const state: Record<FileKind, RecordEntry['state']> = { claudeJson: 'written', settingsJson: 'written' };
  for (const k of changing) state[k] = 'pending';
  const entriesOf = () => KINDS.flatMap((k) => files[k].entries.map((e): RecordEntry => ({ ...e, file: files[k].path, state: state[k] }) as RecordEntry));
  const saveRecord = () => {
    record.entries = entriesOf();
    const f = readJsonFile(places.record, RECORD_CAP, { forWrite: true });
    const was = 'snapshot' in f ? f.snapshot : 'absent';
    if (writeFileText(places.record, `${JSON.stringify(record, null, 2)}\n`, was, folderId(H)) !== 'written') throw new CatalogError('target_changed', { path: places.record });
  };

  const written: string[] = [];
  const backups: string[] = [];
  if (changing.length) {
    if (changing.some((k) => plan.files[k].was !== 'absent')) makeFolder(places.backups);
    if (changing.includes('settingsJson')) makeFolder(places.claudeDir);
    saveRecord();
    for (const k of changing) {
      for (let attempt = 1; ; attempt++) {
        const fp = files[k];
        if (fp.text === undefined) break; // another writer left exactly this run's entries
        let backup: Backup | undefined;
        if (fp.was !== 'absent') {
          const path = join(places.backups, `${utc}-${randomBytes(2).toString('hex')}-${BACKUP_SUFFIX[k]}`);
          const id = writeNew(path, Buffer.from(fp.read!, 'utf8'));
          backup = { file: fp.path, path, sha256: sha256(fp.read!), dev: part(id.dev), ino: part(id.ino), birth: part(id.birthtimeMs) };
        }
        input.seams?.afterRead?.(fp.path, attempt);
        if (writeFileText(fp.path, fp.text, fp.was, folderId(dirname(fp.path))) === 'written') {
          if (backup) {
            record.backups.push(backup);
            backups.push(backup.path);
          }
          if (fp.was === 'absent') record.created_files = [...record.created_files.filter((c) => c.file !== fp.path), { file: fp.path, sha256: sha256(fp.text) }];
          state[k] = 'written';
          written.push(fp.path);
          saveRecord();
          input.seams?.afterWrite?.(fp.path);
          break;
        }
        if (backup) removeOwn(backup);
        if (attempt === TRIES) throw new CatalogError('assistant_file_changed', { path: fp.path });
        files[k] = planFile(k, plan, input.words);
      }
    }
    // Two backups of each file kept: an older one the record lists is deleted only while it's still the copy setup made.
    for (const k of KINDS) {
      const mine = record.backups.filter((b) => b.file === files[k].path);
      for (const old of mine.slice(0, -2)) {
        removeOwn(old);
        record.backups = record.backups.filter((b) => b !== old);
      }
    }
    saveRecord();
  }

  for (const dir of [H, places.backups]) {
    const ignore = join(dir, '.gitignore');
    if (lstatOr(dir)?.isDirectory() && !lstatOr(ignore)) writeNew(ignore, '*\n');
  }
  sweep(places, input.now());
  return { plan, written, backups };
}

// This runner's own temp files (json-write's names for the two files) left over an hour ago, in the two folders it
// writes in: removed only while each is this user's regular file with one link.
const OWN_TEMP = /^\.(?:\.claude\.json|settings\.json)\.skills-catalog-[0-9a-f]{12}\.tmp$/;
function sweep(places: SetupPlan['places'], now: number): void {
  const me = BigInt(process.getuid?.() ?? -1);
  for (const dir of [places.assistantHome, places.claudeDir]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => OWN_TEMP.test(n) && (dir === places.claudeDir) === n.startsWith('.settings.json'))) {
      const path = join(dir, name);
      const s = lstatOr(path);
      if (!s || !s.isFile() || s.uid !== me || s.nlink !== 1n || Number(s.mtimeMs) > now - STALE_TEMP_MS) continue;
      if (basename(path) === name) unlinkSync(path);
    }
  }
}
