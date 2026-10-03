// The PRD's consistency measurement, exactly (NFR "Consistency": "Publish then retrieve; compare against the original"),
// through the assistant's own tools over MCP: a folder with the awkward cases (nested folders, a binary, CRLF and CR-only
// lines, trailing whitespace, a byte-order mark, no final newline, an empty file, names in decomposed form and in other
// scripts, a script with +x, a 0600 file, an empty folder) is published as v1 and v2, then installed at the latest and
// at v1; every file comes back byte for byte. The documented normalisations are expectations, not surprises: two modes
// (contract §4.2), names in composed form (NFC), no empty folders (review P8.2).
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { PROCESS_TEST_MS, place, startServer, type Place } from './server.ts';

const S = Words.load();
const T = S.names as Record<string, string>;
type Fixture = Record<string, { bytes: Buffer; mode: number }>;

const v1: Fixture = {
  'SKILL.md': { bytes: Buffer.from('---\nname: tricky-kit\ndescription: Every awkward file at once.\n---\nUse the files beside this one.\n'), mode: 0o644 },
  'deep/er/est.md': { bytes: Buffer.from('nested\n'), mode: 0o644 },
  'zeros.bin': { bytes: Buffer.from([0, 0, 255, 254, 0, 1, 2, 3, 0]), mode: 0o644 },
  'crlf.txt': { bytes: Buffer.from('one\r\ntwo\r\n'), mode: 0o644 },
  'cr-only.txt': { bytes: Buffer.from('one\rtwo\r'), mode: 0o644 },
  'trailing.md': { bytes: Buffer.from('spaces after  \n\t\n\n'), mode: 0o644 },
  'bom.md': { bytes: Buffer.from('﻿starts with a byte-order mark\n'), mode: 0o644 },
  'nonl.txt': { bytes: Buffer.from('no final newline'), mode: 0o644 },
  'empty.txt': { bytes: Buffer.alloc(0), mode: 0o644 },
  ['café-nfd.md']: { bytes: Buffer.from('decomposed name\n'), mode: 0o644 },
  'émoji-✓/ünïcödé.md': { bytes: Buffer.from('ünïcödé\n'), mode: 0o644 },
  'scripts/run.sh': { bytes: Buffer.from('#!/bin/sh\necho ok\n'), mode: 0o755 },
  'private.txt': { bytes: Buffer.from('mine\n'), mode: 0o600 },
};
const v2: Fixture = { ...v1, 'trailing.md': { bytes: Buffer.from('spaces after  \n\t\n\nand a second version\n'), mode: 0o644 } };

function plant(dir: string, f: Fixture): void {
  for (const [path, { bytes, mode }] of Object.entries(f)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    chmodSync(full, mode);
  }
  mkdirSync(join(dir, 'empty-dir'), { recursive: true });
}

/** Every file under `dir`: its path (as the file system gives it back), sha256 and mode. */
function tree(dir: string, rel = ''): Map<string, { sha: string; mode: number }> {
  const out = new Map<string, { sha: string; mode: number }>();
  for (const name of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, r));
    if (st.isDirectory()) for (const [k, v] of tree(dir, r)) out.set(k, v);
    else out.set(r.normalize('NFC'), { sha: createHash('sha256').update(readFileSync(join(dir, r))).digest('hex'), mode: st.mode & 0o777 });
  }
  return out;
}

/** What the catalog promises to give back for a fixture: the same bytes, the name composed, one of two modes. */
const expected = (f: Fixture) =>
  new Map(Object.entries(f).map(([p, { bytes, mode }]) => [p.normalize('NFC'), { sha: createHash('sha256').update(bytes).digest('hex'), mode: mode & 0o111 ? 0o755 : 0o644 }]));

async function publishFolder(s: ReturnType<typeof startServer>, dir: string): Promise<void> {
  const preview = await s.text(T['publish']!, { folder: dir });
  const m = /confirm "([^"]+)", name "([^"]+)", version (\d+), files (\d+) and flags (\[[^\]]*\])/.exec(preview);
  expect(m, preview).not.toBeNull();
  const r = await s.call(T['publish']!, { folder: dir, confirm: m![1], name: m![2], version: Number(m![3]), files: Number(m![4]), flags: JSON.parse(m![5]!) });
  expect(r.isError, r.content[0]!.text).toBeFalsy();
}

/** install_shared_skill, and the person's yes when it's held (the script holds it). Returns where it went. */
async function installOne(s: ReturnType<typeof startServer>, args: Record<string, unknown>): Promise<string> {
  let text = await s.text(T['install']!, args);
  const held = /with name "([^"]+)", target "([^"]+)", version (\d+), confirm "([^"]+)" and flags (\[[^\]]*\])/.exec(text);
  if (held) text = await s.text(T['accept']!, { name: held[1], target: held[2], version: Number(held[3]), confirm: held[4], flags: JSON.parse(held[5]!) });
  const to = / to ("(?:[^"\\]|\\.)*")/.exec(text);
  expect(to, text).not.toBeNull();
  return JSON.parse(to![1]!) as string;
}

describe('publish, then retrieve, then compare with the original (the PRD\'s consistency measurement)', () => {
  it(
    'every file comes back byte for byte, at the latest and at v1; only the documented normalisations differ',
    async () => {
      const p: Place = place();
      const s = startServer(p, { SKILLS_AS: 'ana' });
      try {
        await s.initialize();
        const work = join(p.dir, 'work');
        const one = join(work, 'v1', 'tricky-kit');
        const two = join(work, 'v2', 'tricky-kit');
        plant(one, v1);
        plant(two, v2);
        await publishFolder(s, one);
        await publishFolder(s, two);

        const latest = await installOne(s, { name: 'tricky-kit' });
        expect(tree(latest)).toEqual(expected(v2));
        const earlier = await installOne(s, { name: 'tricky-kit', version: 1, target: 'project' });
        expect(tree(earlier)).toEqual(expected(v1));
        // No empty folder came back, and the 0600 file is the documented 0644.
        expect(readdirSync(latest)).not.toContain('empty-dir');
        expect(tree(latest).get('private.txt')!.mode).toBe(0o644);
      } finally {
        await s.close();
      }
    },
    PROCESS_TEST_MS,
  );
});
