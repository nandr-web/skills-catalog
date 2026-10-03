// `npm run try-it` (scripts/try-it.ts), run as a reviewer runs it: every PRD item it shows is a scene named after its
// PRD id, in the PRD's order, and each scene shows what the PRD asks (review F4, P1.2, P5.5, P7.1, P10.1): a malformed
// publish refused with nothing stored, nothing matching at all, a fetch compared with what was published, an earlier
// version read after a newer one, a malformed update leaving the versions as they were.
import { describe, expect, it } from 'vitest';
import { runScript } from './run-script.ts';

/** Each scene's title line, and the lines under it. */
function scenes(out: string): { title: string; body: string }[] {
  return out
    .split(/\n(?=\d+\. )/)
    .slice(1)
    .map((s) => {
      const [title, ...rest] = s.split('\n');
      return { title: title!, body: rest.join('\n') };
    });
}

describe('npm run try-it', () => {
  const out = runScript('try-it.ts');
  const all = scenes(out);
  const scene = (prd: string) => {
    const s = all.find((x) => x.title.endsWith(`[${prd}]`));
    expect(s, `a scene tagged [${prd}]`).toBeDefined();
    return s!.body;
  };

  it('tells one story, scene by scene, each tagged with the PRD item it shows', () => {
    expect(all.map((s) => s.title)).toEqual([
      '1. ana publishes two skills  [FR-01]',
      '2. ana publishes a skill whose SKILL.md has no description  [UC-01 rejected]',
      '3. bob searches "changelog for a release"  [FR-02]',
      '4. bob searches "sourdough bread" (nothing in the catalog is about baking)  [UC-02 nothing matches]',
      '5. bob searches "graphql schema" (nothing in the catalog is about GraphQL)  [UC-02 only close]',
      '6. bob reads release-note-draft  [FR-03]',
      '7. bob fetches version 1 and compares it with what ana published  [NFR consistency]',
      '8. bob mistypes a name: relase-note-draft  [UC-03 not found]',
      '9. ana publishes version 2, which adds a script  [FR-04]',
      '10. ana publishes a version 3 whose SKILL.md has no instructions  [UC-04 malformed update]',
      '11. bob looks at the history  [FR-04 history]',
      '12. bob reads version 1, though version 2 is the latest  [FR-04 earlier version]',
      '13. bob compares version 1 with version 2  [FR-04 change visible]',
      '14. bob tries to publish over release-note-draft (only ana, who published it first, may)  [beyond the PRD]',
    ]);
    expect(out.trimEnd().endsWith('Nothing else was changed.')).toBe(true);
  });

  it('refuses a skill with no description, and stores nothing of it', () => {
    const s = scene('UC-01 rejected');
    expect(s).toMatch(/│ invalid_manifest: .*description/);
    expect(s).toMatch(/│ not_found: no skill named "standup-notes"/);
  });

  it('says plainly when nothing matches at all, with no closest skill offered', () => {
    const s = scene('UC-02 nothing matches');
    expect(s).toMatch(/│ Shared catalog: no skill matches/);
    expect(s).not.toMatch(/shares only/);
  });

  it('fetches version 1 complete and unchanged: the same files, byte for byte, and the same fingerprint', () => {
    const s = scene('NFR consistency');
    expect(s).toMatch(/✓ the same 2 files, byte for byte: SKILL\.md, template\.md/);
    expect(s).toMatch(/✓ the same fingerprint: sha256:[0-9a-f]{12}… published, sha256:[0-9a-f]{12}… fetched, sha256:[0-9a-f]{12}… worked out here from ana's files/);
    const fps = [...s.matchAll(/sha256:([0-9a-f]{12})…/g)].map((m) => m[1]);
    expect(new Set(fps).size).toBe(1);
  });

  it('refuses a malformed update and leaves the versions as they were', () => {
    const s = scene('UC-04 malformed update');
    expect(s).toMatch(/│ invalid_manifest: /);
    expect(s).toMatch(/✓ still 2 versions, latest v2, each as it was: nothing of version 3 was stored/);
  });

  it('reads an earlier version when asked for it', () => {
    const s = scene('FR-04 earlier version');
    expect(s).toMatch(/│ release-note-draft v1 /);
    expect(s).not.toMatch(/scripts\/collect\.sh/);
  });

  it('shows the latest version by default, and the history with both versions', () => {
    expect(scene('FR-03')).toMatch(/│ release-note-draft v1 \(latest\)/);
    const h = scene('FR-04 history');
    expect(h).toMatch(/│ release-note-draft: 2 version\(s\), latest v2/);
    expect(h).toMatch(/│ - v2 \(/);
    expect(h).toMatch(/│ - v1 \(/);
  });
});
