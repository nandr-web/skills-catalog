// Shared test helpers: a local catalog in a sandbox with a fixed clock and ids, requests built from golden files,
// and a logical storage snapshot the tests read themselves (rows and blobs, not the database file's bytes).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../src/catalog.ts';
import { CatalogError } from '../src/errors.ts';
import { DB_FILE, openLocalCatalog, type LocalOptions } from '../src/local/index.ts';
import type { RawFile } from './golden.ts';
import { sandbox } from './sandbox.ts';

// The budget of a test that walks a whole golden set or every surface variant: about 2.5 s here and over 5 s on a slower
// machine (Node 24 in a Linux container), so these few get their own budget instead of a global raise.
export const HEAVY_MS = 30_000;

export function fixedClock(start = Date.parse('2026-09-28T12:00:00Z')) {
  let t = start;
  return { now: () => new Date((t += 1000)) };
}

export function counterIds() {
  let n = 0;
  return { next: () => `id${++n}` };
}

export interface Opened {
  dir: string;
  catalog: Catalog;
}

export async function openTest(opts: LocalOptions = {}, dir = sandbox()): Promise<Opened> {
  return { dir, catalog: await openLocalCatalog(join(dir, 'catalog'), { clock: fixedClock(), ids: counterIds(), ...opts }) };
}

export function request(name: string, files: RawFile[], extra: Record<string, unknown> = {}) {
  return { name, files: files.map((f) => ({ path: f.path, mode: f.mode, content_base64: Buffer.from(f.bytes).toString('base64') })), ...extra };
}

export async function errorOf(fn: () => unknown): Promise<CatalogError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error('expected a CatalogError');
}

function walk(dir: string, prefix = ''): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries.sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p, `${prefix}${e}/`));
    else out.push(`${prefix}${e} ${readFileSync(p).length}`);
  }
  return out;
}

// Rows of every table (the outbox's delivery stamps left out) and every blob, read straight from storage.
export function snapshot(dir: string): string {
  const root = join(dir, 'catalog');
  const db = new DatabaseSync(join(root, DB_FILE), { readOnly: true });
  try {
    const rows = (sql: string) => JSON.stringify(db.prepare(sql).all());
    return [
      rows('SELECT * FROM skills ORDER BY name'),
      rows('SELECT * FROM versions ORDER BY name, version'),
      rows('SELECT id, event FROM outbox ORDER BY id'),
      rows('SELECT * FROM search_cards ORDER BY name'),
      walk(join(root, 'blobs')).join('\n'),
    ].join('\n---\n');
  } finally {
    db.close();
  }
}

export function versionsIn(dir: string, name: string): number[] {
  const db = new DatabaseSync(join(dir, 'catalog', DB_FILE), { readOnly: true });
  try {
    return (db.prepare('SELECT version FROM versions WHERE name = ? ORDER BY version').all(name) as { version: number }[]).map((r) => r.version);
  } finally {
    db.close();
  }
}
