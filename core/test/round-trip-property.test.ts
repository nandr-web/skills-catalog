// The round-trip property (qa/traceability.yaml, "A retrieved skill is complete and unchanged"): for generated trees
// (paths at several depths and in several scripts, any bytes, both modes), what fetch gives back is what publish was
// given, file for file, after every version. A seeded generator, so a failure names its seed and replays (review P8.3).
import { describe, expect, it } from 'vitest';
import { actAs } from '../src/local/index.ts';
import { openTest, request } from './helpers.ts';

// A small, fast, seeded generator (mulberry32): the same seed, the same trees.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = ['a', 'b', 'z', 'é', 'ü', 'ж', 'λ', '中', '-', '_', '0', '9'];
type File = { path: string; mode: '0644' | '0755'; bytes: Buffer };

function generate(r: () => number, name: string): File[] {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const word = () => Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(LETTERS)).join('');
  const files = new Map<string, File>();
  files.set('SKILL.md', { path: 'SKILL.md', mode: '0644', bytes: Buffer.from(`---\nname: ${name}\ndescription: Generated tree.\n---\n${word()}\n`) });
  const n = 1 + Math.floor(r() * 12);
  for (let i = 0; i < n; i++) {
    const depth = Math.floor(r() * 4);
    const path = [...Array.from({ length: depth }, word), `${word()}.${pick(['md', 'txt', 'bin', 'json'])}`].join('/');
    if (files.has(path) || [...files.keys()].some((p) => p.startsWith(path + '/') || path.startsWith(p + '/'))) continue;
    const size = pick([0, 1, 7, 64, 1000]);
    const bytes = Buffer.from(Array.from({ length: size }, () => Math.floor(r() * 256)));
    files.set(path, { path: path.normalize('NFC'), mode: r() < 0.2 ? '0755' : '0644', bytes });
  }
  return [...files.values()];
}

const asSet = (fs: readonly { path: string; mode: string; bytes: Buffer | Uint8Array }[]) =>
  Object.fromEntries(fs.map((f) => [f.path, `${f.mode} ${Buffer.from(f.bytes).toString('base64')}`]));

describe('round trip over generated trees (paths, bytes, modes)', () => {
  const SEEDS = Array.from({ length: 25 }, (_, i) => 1000 + i);
  it(`fetch gives back exactly what publish was given, for ${SEEDS.length} seeds and two versions each`, async () => {
    const { catalog } = await openTest();
    try {
      for (const seed of SEEDS) {
        const r = rng(seed);
        const name = `gen-${seed}`;
        const versions = [generate(r, name), generate(r, name)];
        for (const files of versions) await catalog.publish(request(name, files.map((f) => ({ path: f.path, mode: f.mode, bytes: f.bytes }))), actAs('ana'));
        for (const [i, files] of versions.entries()) {
          const got = await catalog.fetch({ name, version: i + 1 });
          // A local catalog answers every file inline (a hosted one may link large ones; not here).
          const back = (got.files as unknown as { path: string; mode: string; content_base64: string }[]).map((f) => ({ path: f.path, mode: f.mode, bytes: Buffer.from(f.content_base64, 'base64') }));
          expect(asSet(back), `seed ${seed}, v${i + 1}`).toEqual(asSet(files));
        }
      }
    } finally {
      catalog.close();
    }
    // 50 publishes and fetches: 1-2 s alone, 6-9 s on a busy machine (the C validator saw vitest's 5 s default fail).
  }, 60_000);
});

// A read shows SKILL.md as it was published: quotes, comments, flow lists and trailing spaces kept (review P8.1).
describe('a read shows SKILL.md byte for byte', () => {
  it('the front matter as written, and the body with its trailing whitespace', async () => {
    const { catalog } = await openTest();
    try {
      const text = '---\nname: "exact-kit"\n# a comment the author left\ndescription: \'Kept as written.\'\ntags: [release, docs]\n---\nBody with trailing spaces   \n\n';
      await catalog.publish(request('exact-kit', [{ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(text) }]), actAs('ana'));
      const r = await catalog.read({ names: ['exact-kit'] });
      const item = r.skills[0] as { manifest: { frontmatter_text?: string; body?: string } };
      expect((item.manifest.frontmatter_text ?? '') + (item.manifest.body ?? '')).toBe(text);
      const { skillMdOf } = await import('../src/render.ts');
      expect(skillMdOf(item as never)).toBe(text);
    } finally {
      catalog.close();
    }
  });
});

// What a read shows inside its fences: only the one final newline goes (the fence line follows), never trailing spaces
// or blank lines (review P8.1; the C validator found no test failing if trimEnd came back).
describe('a read\'s fences keep trailing spaces and blank lines', () => {
  it('in SKILL.md and in a file read with contents', async () => {
    const { catalog } = await openTest();
    try {
      const md = '---\nname: spaced-kit\ndescription: Keeps its whitespace.\n---\nBody   \n\n\n';
      const notes = 'line with spaces   \n\t\n\n';
      await catalog.publish(request('spaced-kit', [{ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(md) }, { path: 'notes.md', mode: '0644', bytes: Buffer.from(notes) }]), actAs('ana'));
      const r = await catalog.read({ name: 'spaced-kit', include: 'contents' });
      const { renderRead, Words } = await import('../src/index.ts');
      const text = renderRead(Words.load(), r, { next: () => 'tok' } as never);
      expect(text).toContain('\nBody   \n\n\n');
      expect(text).toContain('line with spaces   \n\t\n\n');
      expect(text).not.toContain('Body   \n\n\n\n');
    } finally {
      catalog.close();
    }
  });
});
