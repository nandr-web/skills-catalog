// The API page's reference section (docs/api.md): written from the operations' definitions by `npm run api-doc`,
// between two markers, so it can't drift from the code; the rest of the page (its narrative, examples and picture) is
// never touched by it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_DOC_END, API_DOC_START, apiReference, operationPart, withReference } from '../src/api-doc.ts';
import { OPERATIONS, inputSchema, type OperationDef } from '../src/api.ts';
import { COMMON_ERRORS } from '../src/errors.ts';

const PAGE = join(import.meta.dirname, '..', '..', 'docs', 'api.md');
const page = () => readFileSync(PAGE, 'utf8');
// One operation's part of the reference: from its heading to the next one.
const partOf = (ref: string, name: string) => {
  const start = ref.indexOf(`### \`${name}\``);
  const next = ref.indexOf('\n### ', start + 1);
  return ref.slice(start, next < 0 ? undefined : next);
};

describe('the API page\'s reference section (docs/api.md)', () => {
  it('the checked-in page carries what `npm run api-doc` writes now, once, between its markers', () => {
    const text = page();
    expect(text.split(API_DOC_START).length - 1).toBe(1);
    expect(text.split(API_DOC_END).length - 1).toBe(1);
    expect(text === withReference(text), 'docs/api.md\'s reference is out of date: run `npm run api-doc` in core/').toBe(true);
  });

  it('changes nothing outside the markers', () => {
    const text = page();
    const outside = (t: string) => t.slice(0, t.indexOf(API_DOC_START)) + t.slice(t.indexOf(API_DOC_END));
    const stale = text.slice(0, text.indexOf(API_DOC_START) + API_DOC_START.length) + '\nold\n' + text.slice(text.indexOf(API_DOC_END));
    expect(outside(withReference(stale))).toBe(outside(text));
    expect(() => withReference('# A page with no markers\n')).toThrow(/markers/);
  });

  it('names every operation once, in the definitions\' order', () => {
    const ref = apiReference();
    const names = [...ref.matchAll(/^### `([a-z_]+)`$/gm)].map((m) => m[1]);
    expect(names).toEqual(Object.keys(OPERATIONS));
  });

  it('says for each where it runs, its faces, what it changes, its error codes and its output', () => {
    const ref = apiReference();
    for (const def of Object.values(OPERATIONS) as OperationDef[]) {
      const part = partOf(ref, def.name);
      expect(part, def.name).toContain(def.where === 'hosted' ? 'hosted catalogs only' : 'local and hosted catalogs');
      for (const face of def.faces) expect(part, def.name).toContain(`\`${face}\``);
      expect(part, def.name).toContain(`\`${def.effect}\``);
      for (const code of [...def.errors, ...COMMON_ERRORS]) expect(part, `${def.name} ${code}`).toContain(`\`${code}\``);
      if (def.output === 'text') expect(part, def.name).toContain('text');
      else if ('properties' in def.output) for (const field of Object.keys(def.output.properties)) expect(part, `${def.name}.${field}`).toContain(`\`${field}\``);
    }
  });

  it('lists each input as each place takes it: a person-only input marked, a hosted form under its own heading', () => {
    const ref = apiReference();
    for (const def of Object.values(OPERATIONS) as OperationDef[]) {
      const part = partOf(ref, def.name);
      for (const field of Object.keys(inputSchema(def, 'cli', 'local').properties)) expect(part, `${def.name}.${field}`).toContain(`\`${field}\``);
      for (const field of def.cliOnly ?? []) expect(part, `${def.name}.${field}`).toMatch(new RegExp(`\`${field}\`[^\\n]*CLI only`));
      if (def.hostedForm) {
        expect(part, def.name).toContain('Hosted, instead');
        for (const field of Object.keys(def.hostedForm)) expect(part.slice(part.indexOf('Hosted, instead')), `${def.name}.${field}`).toContain(`\`${field}\``);
      }
    }
    // A hosted-only operation with a hosted form (none is in the table yet): said as the definition says it.
    const hostedOnly: OperationDef = {
      name: 'hosted_example', kind: 'catalog', phase: 'aws', faces: ['web'], effect: 'reads', run: 'x', output: 'text', errors: [], where: 'hosted',
      input: { type: 'object', properties: { name: { type: 'string', maxLength: 200 }, files: { type: 'array', items: { type: 'string' } } }, required: ['name'] },
      hostedForm: { files: { type: 'array', items: { type: 'object', properties: { sha256: { type: 'string', maxLength: 64 } } }, maxItems: 7 } },
    };
    const hosted = operationPart(hostedOnly);
    expect(hosted).toContain('hosted catalogs only');
    expect(hosted).not.toContain('local and hosted catalogs');
    expect(hosted.slice(hosted.indexOf('Hosted, instead'))).toMatch(/`files`[^\n]*7[\s\S]*`sha256`[^\n]*64/);
    // A field that takes any error code points to the error list instead of repeating it: read's part names only the
    // codes read can raise.
    const read = partOf(ref, 'read_shared_skill');
    expect(read).toMatch(/`code`: an error code[^\n]*\(contract\.md#9-error-codes\)/);
    expect(read).not.toContain('`fingerprint_mismatch`');
    // Any other field's values are said, one by one.
    expect(partOf(ref, 'search_shared_skills')).toMatch(/`match`: one of `all`, `partial`, `none`/);
    // Limits are said: a string's length, a list's size, a number's range, the values a field takes.
    const search = partOf(ref, 'search_shared_skills');
    expect(search).toMatch(/`limit`[^\n]*1[^\n]*50/);
    expect(search).toMatch(/`query`[^\n]*500/);
  });
});

// The page's hand-written top (review V5.3, V5.7, V6.3): its at-a-glance tables and picture said HTTP was planned long
// after it was built. Their chips are checked against the definitions here, so they can't drift again.
describe('the API page\'s at-a-glance tables and picture (docs/api.md, pictures/api-overview.svg)', () => {
  const PICTURE = join(import.meta.dirname, '..', '..', 'docs', 'pictures', 'api-overview.svg');
  /** The rows of the at-a-glance tables: operation name and its Tool, CLI and HTTP cells. */
  const glance = (text: string) => {
    const top = text.slice(text.indexOf('## The operations at a glance'), text.indexOf('## What every call shares'));
    return [...top.matchAll(/^\| \[([a-z_]+)\]\(#[^)]*\) \| .* \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((m) => ({ name: m[1]!, tool: m[2]!.trim(), cli: m[3]!.trim(), http: m[4]!.trim() }));
  };
  // GitHub's anchor for a heading: lower case, punctuation dropped (hyphens and underscores kept), spaces to hyphens.
  const slug = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');

  it('lists every operation once, its chips as its definition says: a face it has is built, one it lacks is not', () => {
    const rows = glance(page());
    const defs = Object.values(OPERATIONS) as OperationDef[];
    for (const def of defs) {
      const row = rows.filter((r) => r.name === def.name);
      expect(row, def.name).toHaveLength(1);
      const { tool, cli, http } = row[0]!;
      expect(tool.startsWith('built'), `${def.name} Tool: ${tool}`).toBe(def.faces.includes('mcp'));
      expect(cli.startsWith('built'), `${def.name} CLI: ${cli}`).toBe(def.faces.includes('cli'));
      expect(http, def.name).toBe(def.faces.includes('web') ? 'built' : 'never');
    }
    // A row with no definition is a design, and says so.
    for (const r of rows.filter((x) => !(x.name in OPERATIONS))) expect([r.tool, r.cli], r.name).toEqual(['not built', 'not built']);
  });

  it('the picture shows every operation and no "planned" chip, in light and dark', () => {
    const svg = readFileSync(PICTURE, 'utf8');
    for (const name of Object.keys(OPERATIONS)) expect(svg, name).toContain(`>${name}<`);
    expect(svg).not.toMatch(/>(?:planned|on a branch|ON A BRANCH)</);
    expect(svg).toContain('prefers-color-scheme: dark');
  });

  it('every link to a heading on the page has that heading', () => {
    const text = page();
    const anchors = new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!.replace(/`/g, ''))));
    const links = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(10);
    expect(links.filter((l) => !anchors.has(l))).toEqual([]);
  });
});
