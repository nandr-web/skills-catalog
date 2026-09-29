// One Unicode version for the rules reviewer's emoji (contract §5.3): which characters are pictographs and skin tones comes
// from config/emoji-properties.txt, made from Unicode's emoji-data.txt 16.0, never the runtime's properties, so a
// variation selector or joiner inside an emoji is spared the same on every machine.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMOJI_PROPERTIES_FILE, EMOJI_MODIFIER, EXTENDED_PICTOGRAPHIC, SPACE_SEPARATORS, reviewFlags } from '../src/skill-tree/index.ts';

const core = join(import.meta.dirname, '..');
const extract = readFileSync(join(core, 'scripts', 'unicode', 'emoji-data-16.0.0-Emoji_Modifier_Extended_Pictographic.txt'), 'utf8');
const hidden = (line: string) =>
  reviewFlags(null, { files: [{ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(`---\nname: x\ndescription: y\n---\n${line}\n`) }], publisher: 'a' })
    .filter((f) => f.kind === 'prompt_injection')
    .map((f) => f.detail);

describe('the emoji table', () => {
  it('is made from emoji-data.txt for Emoji 16.0, whose header the extract keeps as it is', () => {
    expect(extract).toMatch(/^# emoji-data\.txt$/m);
    expect(extract).toMatch(/^# Date: 2024-05-01, 21:25:24 GMT$/m);
    expect(extract).toMatch(/^# Used with Emoji Version 16\.0 and subsequent minor revisions \(if any\)$/m);
    expect(extract).toMatch(/\(SHA-256 f1365a5173eee18e1f98b240cdc492e84a25f1ce7e0c9d1094eb29c41a22696a, 113024 bytes\)/);
    expect(readFileSync(EMOJI_PROPERTIES_FILE, 'utf8')).toMatch(/^# Emoji 16\.0,/m);
  });

  it('holds every code point the extract lists for each property, as many as the extract\'s own totals', () => {
    for (const [property, pattern, total] of [['Extended_Pictographic', EXTENDED_PICTOGRAPHIC, 3537], ['Emoji_Modifier', EMOJI_MODIFIER, 5]] as const) {
      const section = extract.slice(extract.indexOf(`have ${property}=No`));
      const stated = Number(/^# Total elements: (\d+)$/m.exec(section)?.[1]);
      let count = 0;
      for (const m of extract.matchAll(new RegExp(`^([0-9A-F]{4,6})(?:\\.\\.([0-9A-F]{4,6}))?\\s*; ${property}\\b`, 'gm'))) {
        const from = parseInt(m[1]!, 16);
        const to = parseInt(m[2] ?? m[1]!, 16);
        count += to - from + 1;
        for (const cp of [from, to]) expect(pattern.test(String.fromCodePoint(cp)), `${property} ${cp.toString(16)}`).toBe(true);
      }
      expect([count, stated], property).toEqual([total, total]);
      for (const cp of [0x41, 0x20, 0x1f3fa]) if (property === 'Emoji_Modifier') expect(pattern.test(String.fromCodePoint(cp))).toBe(false);
    }
    expect(EXTENDED_PICTOGRAPHIC.test('A')).toBe(false);
  });

  it('decides what the reviewer spares: a selector after a pictograph, a joiner between two, a skin tone before a joiner', () => {
    const at = (...p: number[]) => String.fromCodePoint(...p);
    expect(hidden(`Mail ${at(0x2709, 0xfe0f)} here.`)).toEqual([]);
    expect(hidden(`Arrow ${at(0x2192, 0xfe0f)} here.`)).toEqual(['hidden character U+FE0F']); // not a pictograph in 16.0
    expect(hidden(`Coder ${at(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb)} here.`)).toEqual([]);
    expect(hidden(`Letter ${at(0x41, 0x200d, 0x1f4bb)} here.`)).toEqual(['hidden character U+200D']);
  });

  // The script needs no Unicode data from Python itself, so any python3 runs it; without one the test says it skipped, and why.
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  it('matches a fresh run of scripts/emoji-properties.py, which checks the totals and the version line', (ctx) => {
    if (python.status !== 0) ctx.skip('no python3 on this machine, so the table was not compared with a fresh run');
    const r = spawnSync('python3', [join(core, 'scripts', 'emoji-properties.py'), '--check'], { encoding: 'utf8' });
    expect([r.status, r.stderr]).toEqual([0, '']);
  });

  it('is the reviewer\'s only source for emoji properties: no emoji property escape in review.ts', () => {
    const source = readFileSync(join(core, 'src', 'skill-tree', 'review.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(/\\[pP]\{(?:Extended_Pictographic|Emoji\w*)\}/.test(source)).toBe(false);
  });
});

// The space separators the reviewer spares come from Unicode 16.0 too: its 17 Zs code points, listed here, never the
// runtime's \p{Zs}. Only \p{L} (comment letters) is left to the runtime, and it never decides which character is hidden.
describe('the space separators', () => {
  const ZS_16 = [0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000];
  it('are Unicode 16.0\'s 17, and none is flagged as hidden', () => {
    expect(SPACE_SEPARATORS.length).toBe(17);
    expect([...SPACE_SEPARATORS]).toEqual(ZS_16);
    for (const cp of ZS_16) expect(hidden(`Keep${String.fromCodePoint(cp)}it short.`), cp.toString(16)).toEqual([]);
    // the Mongolian vowel separator stopped being one in Unicode 6.3: it's hidden
    expect(hidden(`Keep${String.fromCodePoint(0x180e)}it short.`)).toEqual(['hidden character U+180E']);
  });
  it('no property escape but \\p{L} is left in review.ts', () => {
    const source = readFileSync(join(core, 'src', 'skill-tree', 'review.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect([...source.matchAll(/\\\\?[pP]\{(\w+)\}/g)].map((m) => m[1])).toEqual(['L']);
  });
});
