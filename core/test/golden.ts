// Reads the QA goldens (qa/golden/) into trees the tests publish. The goldens are the oracles: nothing here fills in
// or changes an expected value.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_CONTEXT_COST_BUDGET, DEFAULT_LIMITS, type Limits, type Mode } from '../src/skill-tree/index.ts';

export const GOLDEN = join(import.meta.dirname, '..', '..', 'qa', 'golden');

export function loadGolden<T = any>(file: string): T {
  return parse(readFileSync(join(GOLDEN, file), 'utf8')) as T;
}

export interface RawFile {
  path: string;
  mode: Mode | string;
  bytes: Uint8Array;
}

// Content forms (skills.yaml header): a string; {base64}; {crlf, text}; {bom, text}; {size, fill}; {mode, text}.
// Links, hardlinks and fifos exist only on disk (the folder reader, slice 2), so they come back as null here.
export function contentOf(v: any, limits: Limits = DEFAULT_LIMITS): { bytes: Uint8Array; mode: string } | null {
  if (typeof v === 'string') return { bytes: Buffer.from(v, 'utf8'), mode: '0644' };
  if (v.symlink || v.hardlink || v.fifo) return null;
  if (v.base64 !== undefined) return { bytes: Buffer.from(v.base64, 'base64'), mode: v.mode ?? '0644' };
  if (v.size !== undefined) {
    const size = typeof v.size === 'number' ? v.size : evalLimit(v.size, limits);
    return { bytes: Buffer.alloc(size, v.fill ?? 'x'), mode: v.mode ?? '0644' };
  }
  let text: string = v.text ?? '';
  if (v.crlf) text = text.replace(/\n/g, '\r\n');
  if (v.pad_to !== undefined) text = text.padEnd(v.pad_to, v.fill ?? 'x'); // {text, pad_to, fill}: text, then fill to pad_to bytes (ASCII)
  const bytes = Buffer.from(text, 'utf8');
  return { bytes: v.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes, mode: v.mode ?? '0644' };
}

function evalLimit(expr: string, limits: Limits): number {
  const m = /^limit\.(\w+)(?:\s*\+\s*(\d+))?$/.exec(expr.trim());
  if (!m) throw new Error(`unknown limit expression ${expr}`);
  return (limits as any)[m[1]!] + Number(m[2] ?? 0);
}

export function filesOf(spec: Record<string, any>, limits: Limits = DEFAULT_LIMITS): RawFile[] | null {
  const out: RawFile[] = [];
  for (const [path, v] of Object.entries(spec)) {
    const c = contentOf(v, limits);
    if (!c) return null;
    out.push({ path, mode: c.mode, bytes: c.bytes });
  }
  return out;
}

export function rawFilesOf(list: any[]): RawFile[] {
  return list.map((f) => ({ path: String(f.path), mode: f.mode ?? '0644', bytes: Buffer.from(f.text ?? '', 'utf8') }));
}

const skillMd = (name: string, description: string, body = 'Body.\n') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

// The `generate:` fixtures, built from their one-line recipe.
export function generated(name: string, limits: Limits = DEFAULT_LIMITS): RawFile[] {
  const md = (description = 'Generated.', body?: string) => ({ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(skillMd(name, description, body)) });
  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f/${String(i).padStart(3, '0')}.md`, mode: '0644', bytes: Buffer.from(`line ${i}\n`) }));
  const fill = (total: number, taken: number) => {
    const out: RawFile[] = [];
    let left = total - taken;
    let i = 0;
    while (left > 0) {
      const size = Math.min(left, limits.file_bytes - 1);
      out.push({ path: `blob-${i++}.bin`, mode: '0644', bytes: Buffer.alloc(size, 'x') });
      left -= size;
    }
    return out;
  };
  switch (name) {
    case 'files-at-limit':
      return [md(), ...lines(limits.files - 1)];
    case 'files-over-limit':
      return [md(), ...lines(limits.files)];
    case 'skill-at-limit': {
      const m = md();
      return [m, ...fill(limits.skill_bytes, m.bytes.length)];
    }
    case 'skill-over-limit': {
      const m = md();
      return [m, ...fill(limits.skill_bytes + 1, m.bytes.length)];
    }
    case 'description-1024':
      return [md('d'.repeat(1024))];
    case 'description-1025':
      return [md('d'.repeat(1025))];
    case 'context-heavy': {
      // One estimated token over the rules reviewer's default budget (contract §5.3: UTF-8 bytes / 4, rounded up).
      const head = skillMd(name, 'Generated.', '');
      return [md('Generated.', 'w'.repeat(DEFAULT_CONTEXT_COST_BUDGET * 4 - Buffer.byteLength(head) + 1))];
    }
    default:
      throw new Error(`no recipe for generated fixture ${name}`);
  }
}

// The fixture's catalog name: `publish_as`, else the front matter's name when it is a valid name, else the fixture
// key (so a fixture with a bad name in its front matter is refused for that name, not for the request's).
export function catalogNameOf(key: string, fx: any, files: RawFile[] | null): string {
  if (fx.publish_as) return fx.publish_as;
  const md = files?.find((f) => f.path === 'SKILL.md');
  const m = md ? /\nname:\s*(.*?)\r?\n/.exec(Buffer.from(md.bytes).toString('utf8')) : null;
  const name = m?.[1]?.trim();
  return name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64 ? name : key;
}

export function historyVersion(spec: Record<string, any>): RawFile[] {
  return filesOf(spec)!;
}
