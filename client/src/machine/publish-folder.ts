// publish_skill_to_catalog (contract §3): a skill folder on this machine becomes a new version in the shared catalog, in
// two steps, so the person sees what will be published before it is. Step 1 (no confirm) reads the folder, runs the
// core's own checks as a dry run (the owner, the manifest, the files, the secret scan: nothing is stored) and lists what
// it would send and skip, with a confirm tied to the folder's fingerprint and the latest version it started from. Step 2
// (with that confirm) reads the folder again: a changed folder is a conflict naming the folder; a version published in
// between is the core's own conflict. The confirm is never an authority: step 2 checks everything again.
//
// The folder is read as regular files only: a link (in or out), a hard link or a special file is invalid_path, and its
// target is never read. The ignore list (.git, .env*, *.pem, id_*, .DS_Store) is skipped and reported, never read.

import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, validateInput, type PublishResult } from '@skills-catalog/core';
import { DEFAULT_LIMITS, checkManifest, checkTree, fingerprint, sha256Hex, type Mode, type RiskFlag } from '@skills-catalog/core/skill-tree';
import { logWords } from '../activity.ts';
import type { Context, Done } from '../operations.ts';

type Input = { folder: string; message?: string; confirm?: string; allow_suspected_secrets?: boolean };
type Folder = { files: { path: string; mode: Mode; bytes: Buffer }[]; skipped: string[] };

const quoted = (p: string) => JSON.stringify(p);
const list = (xs: readonly string[]) => xs.join(', ');

// The ignore list, by name at any depth: files the person keeps next to a skill and never means to publish.
const ignoredFile = (name: string) => name === '.DS_Store' || name.startsWith('.env') || name.endsWith('.pem') || name.startsWith('id_');
const ignoredFolder = (name: string) => name.toLowerCase() === '.git';

function notRegular(path: string): never {
  throw new CatalogError('invalid_path', { path, why: 'not_regular_file' });
}

// Every file under an ignored folder, by name only: nothing in it is read or followed.
function namesUnder(dir: string, rel: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) namesUnder(join(dir, e.name), r, out);
    else out.push(r);
  }
}

// The folder's files, with a size check before any byte is read (the core's limits refuse the rest).
export function readFolder(root: string): Folder {
  let top: Stats;
  try {
    top = lstatSync(root);
  } catch {
    throw new CatalogError('invalid_manifest', { problem: 'missing', fields: ['SKILL.md'] });
  }
  if (!top.isDirectory()) throw new CatalogError('invalid_manifest', { problem: 'missing', fields: ['SKILL.md'] });
  const found: { path: string; full: string; st: Stats }[] = [];
  const skipped: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) notRegular(r);
      if (st.isDirectory()) {
        if (ignoredFolder(e.name)) namesUnder(full, r, skipped);
        else walk(full, r);
      } else if (st.isFile()) {
        if (ignoredFile(e.name)) skipped.push(r);
        else if (st.nlink > 1) notRegular(r); // a hard link may be another file's bytes, outside this folder
        else found.push({ path: r, full, st });
      } else notRegular(r);
    }
  };
  walk(root, '');
  const limits = DEFAULT_LIMITS;
  if (found.length > limits.files) throw new CatalogError('too_large', { limit: 'files', max: limits.files, value: found.length });
  let total = 0;
  for (const f of found) {
    if (f.st.size > limits.file_bytes) throw new CatalogError('too_large', { limit: 'file_bytes', max: limits.file_bytes, value: f.st.size, path: f.path });
    total += f.st.size;
  }
  if (total > limits.skill_bytes) throw new CatalogError('too_large', { limit: 'skill_bytes', max: limits.skill_bytes, value: total });
  const files = found.map((f) => ({ path: f.path, mode: (f.st.mode & 0o111 ? '0755' : '0644') as Mode, bytes: readFileSync(f.full) }));
  return { files, skipped: skipped.sort() };
}

// What the confirm binds: the skill, the folder's content, and the latest version the preview started from.
type Token = { name: string; fingerprint: string; expected_latest: number };
const encode = (t: Token) => Buffer.from(JSON.stringify(t)).toString('base64url');
function decode(confirm: string): Token {
  try {
    const t = JSON.parse(Buffer.from(confirm, 'base64url').toString('utf8'));
    if (typeof t.name === 'string' && typeof t.fingerprint === 'string' && Number.isSafeInteger(t.expected_latest)) return t;
  } catch {
    // falls through
  }
  throw new CatalogError('invalid_request', { field: 'confirm', why: 'not_a_confirm' });
}

// A refusal about the folder's own content names the folder, so its sentence can say where to fix it.
function inFolder(e: unknown, folder: string): unknown {
  if (e instanceof CatalogError && ['invalid_manifest', 'invalid_name', 'invalid_path', 'secret_suspected', 'too_large'].includes(e.code)) {
    return new CatalogError(e.code, { ...e.data, folder });
  }
  return e;
}

export async function publishFolder(ctx: Context, args: unknown): Promise<Done> {
  const req = validateInput<Input>('publish_skill_to_catalog', args, ctx.face);
  const s = ctx.surface;
  const w = s.word('publish');
  const log = logWords(s);
  try {
    const { files, skipped } = readFolder(req.folder);
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

    if (req.confirm === undefined) {
      // A dry run creates nothing: the same bytes as the latest come back as that version with nothing changed; anything
      // else as the version it would become.
      const r: PublishResult = await catalog.publish({ ...input, dry_run: true });
      const identical = r.diff_from_latest !== null && r.diff_from_latest.files.length === 0;
      const latest = identical ? r.version : r.version - 1;
      if (identical) return { text: s.format(w.identical, { folder: req.folder, name, latest }), target: `${name} v${latest}`, result: log.result('publish', 'identical') };
      const changed = (r.diff_from_latest?.files ?? []).map((f) => quoted(f.path));
      const notes = r.risk_flags.map((f: RiskFlag) => s.format(s.word('quality.note')[f.kind], { path: f.path ?? '', detail: f.detail }));
      const text = s.format(w.preview, {
        name,
        version: r.version,
        change: latest === 0 ? w.new_skill : s.format(w.change_from, { latest, files: list(changed) }),
        n_send: files.length,
        send: list(files.map((f) => quoted(f.path))),
        n_skip: skipped.length,
        skip: skipped.length ? list(skipped.map(quoted)) : w.skip_none,
        review: notes.length ? s.format(w.review, { notes: notes.join('; ') }) : '',
        folder: req.folder,
        confirm: encode({ name, fingerprint: fp, expected_latest: latest }),
      });
      return { text, target: `${name} v${r.version}`, result: log.result('publish', 'preview') };
    }

    const t = decode(req.confirm);
    if (t.name !== name || t.fingerprint !== fp) throw new CatalogError('conflict', { name, folder: req.folder });
    const r = await catalog.publish({ ...input, expected_latest: t.expected_latest });
    if (!r.created) return { text: s.format(w.identical, { folder: req.folder, name, latest: r.version }), target: `${name} v${r.version}`, result: log.result('publish', 'identical') };
    return { text: s.format(w.published, { name, version: r.version }), target: `${name} v${r.version}`, result: log.result('publish', 'published') };
  } catch (e) {
    throw inFolder(e, req.folder);
  }
}
