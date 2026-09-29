// The API page's reference section (docs/api.md): written from the operations' definitions by `npm run api-doc`,
// between two markers, so it can't drift from the code; the rest of the page (its narrative, examples and picture) is
// never touched by it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_DOC_END, API_DOC_START, apiReference, withReference } from '../src/api-doc.ts';
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
    // Limits are said: a string's length, a list's size, a number's range, the values a field takes.
    const search = partOf(ref, 'search_shared_skills');
    expect(search).toMatch(/`limit`[^\n]*1[^\n]*50/);
    expect(search).toMatch(/`query`[^\n]*500/);
  });
});
