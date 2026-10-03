// Re-indexing one skill after version_published (contract §5.1 step 4): the latest version's card goes to the search
// index, read from storage rather than taken from the event, so a late or repeated event can't put an old card back.
// The catalog's own subscriber and a hosted indexer run this one function.

import { describe, expect, it } from 'vitest';
import { indexSkill, type SearchCard, type SkillRecord, type VersionRecord } from '../src/index.ts';
import type { Review } from '../src/skill-tree/index.ts';

function version(name: string, n: number): VersionRecord {
  return {
    name,
    version: n,
    fingerprint: `fp-${n}`,
    publisher: 'dev1',
    message: '',
    published_at: `2026-09-29T00:0${n}:00.000Z`,
    files: [],
    description: `version ${n} of ${name}`,
    tags: [`t${n}`],
    frontmatter: {},
  };
}

function world(skills: Record<string, VersionRecord[]>, reviews: Record<string, Review[]> = {}) {
  const upserts: SearchCard[] = [];
  const storage = {
    skill: async (name: string): Promise<SkillRecord | undefined> => {
      const vs = skills[name];
      return vs ? { name, owners: ['dev1'], latest: vs.length } : undefined;
    },
    version: async (name: string, n: number) => skills[name]?.[n - 1],
    reviews: async (name: string, n: number) => reviews[`${name}@${n}`] ?? [],
  };
  const index = { upsert: async (c: SearchCard) => void upserts.push(c) };
  return { storage, index, upserts };
}

describe('indexSkill', () => {
  it("upserts the latest version's card, not an earlier one", async () => {
    const w = world({ pdf: [version('pdf', 1), version('pdf', 2)] });
    await indexSkill(w, 'pdf');
    expect(w.upserts).toEqual([
      { name: 'pdf', description: 'version 2 of pdf', latest_version: 2, tags: ['t2'], publisher: 'dev1', updated_at: '2026-09-29T00:02:00.000Z' },
    ]);
  });

  it('run twice for the same event, it upserts the same card both times', async () => {
    const w = world({ pdf: [version('pdf', 1), version('pdf', 2)] });
    await indexSkill(w, 'pdf');
    await indexSkill(w, 'pdf');
    expect(w.upserts).toHaveLength(2);
    expect(w.upserts[1]).toEqual(w.upserts[0]);
  });

  it('a name storage has no skill for: nothing is upserted and nothing throws', async () => {
    const w = world({});
    await expect(indexSkill(w, 'gone')).resolves.toBeUndefined();
    expect(w.upserts).toEqual([]);
  });

  it("the card carries what the latest version's reviews flagged, one flag of each kind, and nothing for an older version's", async () => {
    const flag = (line: number) => ({ kind: 'prompt_injection' as const, path: 'SKILL.md', line, detail: 'ignore previous instructions' });
    const review = (flags: ReturnType<typeof flag>[]): Review => ({ reviewer: 'rules', reviewer_version: '1', fingerprint: 'fp', at: '2026-09-29T00:00:00.000Z', measurements: {}, flags, findings: [] });
    const w = world({ pdf: [version('pdf', 1), version('pdf', 2)] }, { 'pdf@1': [review([flag(9)])], 'pdf@2': [review([flag(5), flag(6)])] });
    await indexSkill(w, 'pdf');
    expect(w.upserts[0]!.quality).toEqual({ flags: [flag(5)] });
    const clean = world({ pdf: [version('pdf', 1), version('pdf', 2)] }, { 'pdf@1': [review([flag(9)])], 'pdf@2': [review([])] });
    await indexSkill(clean, 'pdf');
    expect('quality' in clean.upserts[0]!).toBe(false);
  });
});
