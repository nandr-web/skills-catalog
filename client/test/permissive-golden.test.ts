// How the installer tells a permissive mode, from the goldens as they are (policy.yaml permissive_settings; contract §5.3
// "How the installer tells", §8 SKILLS_MANAGED_SETTINGS): each row's settings files written into a sandbox, the mode found
// (null: none) and the files setup's summary names (`unusable`, in reading order). A row marked `pending` is skipped.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { permissiveMode } from '../src/machine/permissive.ts';
import { settingsFrom } from '../src/settings.ts';
import { place, type Place } from './server.ts';

type Row = { files: Record<string, unknown>; mode: string | null; unusable?: { file: string; why: string; key?: string }[]; note?: string; pending?: string };
const rows = loadGolden('policy.yaml').permissive_settings as Row[];
const RUN_ID = 'golden-run';
const asRoot = process.getuid?.() === 0;

// Where each file key lives in the sandbox.
function pathOf(p: Place, key: string): string {
  if (key === 'managed') return join(p.managed, 'managed-settings.json');
  if (key.startsWith('managed.d/')) return join(p.managed, 'managed-settings.d', key.slice('managed.d/'.length));
  if (key === 'project_local') return join(p.dir, 'project', '.claude', 'settings.local.json');
  if (key === 'project') return join(p.dir, 'project', '.claude', 'settings.json');
  if (key === 'user') return join(p.osHome, '.claude', 'settings.json');
  throw new Error(`a file key this runner doesn't know: ${key}`);
}

// The harness's special values: {$raw} as is, {$over_bytes} valid JSON padded to that size, {$link_to} a link to a file
// holding it, {$unreadable} a file of mode 000.
function write(p: Place, path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const o = v as Record<string, unknown>;
  if (o && typeof o === 'object' && '$raw' in o) return writeFileSync(path, String(o['$raw']).replaceAll('$RUN_ID', RUN_ID));
  if (o && typeof o === 'object' && '$over_bytes' in o) return writeFileSync(path, '{}'.padEnd(Number(o['$over_bytes']), ' '));
  if (o && typeof o === 'object' && '$link_to' in o) {
    const target = join(p.dir, `linked-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(target, JSON.stringify(o['$link_to']));
    return symlinkSync(target, path);
  }
  if (o && typeof o === 'object' && '$unreadable' in o) {
    writeFileSync(path, JSON.stringify(o['$unreadable']));
    return chmodSync(path, 0o000);
  }
  writeFileSync(path, JSON.stringify(v));
}

describe('the permissive mode, from the goldens (policy.yaml permissive_settings)', () => {
  rows.forEach((r, i) => {
    const unreadable = JSON.stringify(r.files).includes('"$unreadable"');
    (r.pending || (unreadable && asRoot) ? it.skip : it)(`permissive_settings[${i}]${r.note ? `: ${r.note}` : ''}`, () => {
      const p = place();
      mkdirSync(join(p.dir, 'project'), { recursive: true });
      for (const [key, v] of Object.entries(r.files)) write(p, pathOf(p, key), v);
      const settings = settingsFrom({ SKILLS_HOME: p.home, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed }, join(p.dir, 'project'));
      const found = permissiveMode(settings);
      const unusable = (r.unusable ?? []).map((u) => ({ path: pathOf(p, u.file), why: u.why, ...(u.key ? { key: u.key } : {}) }));
      expect({ mode: found.mode ?? null, unusable: found.unusable ?? [] }).toEqual({ mode: r.mode, unusable });
    });
  });
});
