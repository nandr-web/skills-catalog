// README.md's copies of what core's commands print can't drift from what they print (review P14.6, P15.5). Each copy
// is a ```text block with a marker on the line before it, `<!-- checked: npm run try-it -->`, and is checked here
// against a real run:
//   - npm run try-it: the script itself, line for line.
//   - npm run perf: a small run (30 skills, 5 calls each), with "(numbers vary)": every number matches any number.
//     Where client/ isn't installed, perf skips its MCP server lines (and says so), so the copy's MCP lines are left out.
//   - npm run check: can't run itself, so its two header lines are checked against package.json and its last lines
//     against vitest's summary shape (numbers vary).
// How a copy matches: a line that is only "…" (after the │ an assistant's lines carry) stands for lines left out; a "…"
// inside a line stands for any text; a date (2026-10-03) matches any date and an id (a UUID) any id. Every other
// character is compared as it is, and a copy that doesn't end in "…" must reach the end of the output.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScript } from './run-script.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const PKG = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { name: string; version: string; scripts: Record<string, string>; engines: { node: string } };

type Sample = { command: string; numbersVary: boolean; lines: string[] };

function samples(readme: string): Sample[] {
  const out: Sample[] = [];
  for (const m of readme.matchAll(/<!-- checked: (.+?)( \(numbers vary\))? -->\n+```text\n([\s\S]*?)\n```/g)) {
    out.push({ command: m[1]!, numbersVary: m[2] !== undefined, lines: m[3]!.split('\n') });
  }
  return out;
}

const GAP = /^\s*(│\s*)?…\s*$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pattern(line: string, numbersVary: boolean): RegExp {
  const token = new RegExp(`(…|\\d{4}-\\d{2}-\\d{2}|${UUID}${numbersVary ? '|\\d+(?:\\.\\d+)?' : ''})`);
  const re = line
    .trimEnd()
    .split(token)
    .map((part, i) => {
      if (i % 2 === 0) return escape(part);
      if (part === '…') return '.*';
      if (/^\d{4}-/.test(part)) return '\\d{4}-\\d{2}-\\d{2}';
      if (part.length === 36 && part.includes('-')) return UUID;
      return '\\d+(?:\\.\\d+)?';
    })
    .join('');
  return new RegExp(`^${re}$`);
}

/** Where the copy first fails to match the real output, or undefined if all of it matches. */
function mismatch(copy: string[], real: string[], numbersVary: boolean): string | undefined {
  const lines = real.map((l) => l.trimEnd());
  while (lines.length && lines.at(-1) === '') lines.pop();
  let j = 0;
  let gap = false;
  for (const line of copy) {
    if (GAP.test(line)) {
      gap = true;
      continue;
    }
    const re = pattern(line, numbersVary);
    if (gap) {
      while (j < lines.length && !re.test(lines[j]!)) j++;
    }
    if (j >= lines.length || !re.test(lines[j]!)) return `README line ${JSON.stringify(line)} doesn't match the output${j < lines.length ? ` line ${JSON.stringify(lines[j])}` : "'s end"}`;
    j++;
    gap = false;
  }
  if (!gap && j < lines.length) return `the output goes on after the README's copy ends: ${JSON.stringify(lines[j])}`;
  return undefined;
}

describe('the matcher', () => {
  it('compares line for line, with … for left-out lines and any text, and dates, ids and numbers where they vary', () => {
    expect(mismatch(['a', '   │ …', 'd'], ['a', '   │ b', '   │ c', 'd'], false)).toBeUndefined();
    expect(mismatch(['a …'], ['a anything'], false)).toBeUndefined();
    expect(mismatch(['on 2026-09-29.'], ['on 2026-10-03.'], false)).toBeUndefined();
    expect(mismatch(['p95 1.5 ms'], ['p95 22.0 ms'], true)).toBeUndefined();
    expect(mismatch(['p95 1.5 ms'], ['p95 22.0 ms'], false)).toMatch(/doesn't match/);
    expect(mismatch(['a', 'b'], ['a', 'c'], false)).toMatch(/"b".*"c"/);
    expect(mismatch(['a'], ['a', 'b'], false)).toMatch(/goes on/);
    expect(mismatch(['a', '…'], ['a', 'b'], false)).toBeUndefined();
    expect(mismatch(['x.y'], ['xzy'], false)).toMatch(/doesn't match/);
  });
});

describe("README.md's copies of what core's commands print", () => {
  const all = samples(README);
  const one = (command: string) => {
    const s = all.filter((x) => x.command === command);
    expect(s, `README.md has one checked copy of ${command}`).toHaveLength(1);
    return s[0]!;
  };

  it('every "What it printed" block is a checked copy', () => {
    const printed = [...README.matchAll(/<summary>What it printed[\s\S]*?<\/details>/g)].map((m) => m[0]);
    expect(printed.length).toBeGreaterThan(0);
    for (const block of printed) expect(block, block.slice(0, 120)).toMatch(/<!-- checked: /);
    expect(all.map((s) => s.command).sort()).toEqual(['npm run check', 'npm run perf', 'npm run try-it']);
  });

  it('npm run try-it: the copy matches a real run', { timeout: 30_000 }, () => {
    const s = one('npm run try-it');
    expect(mismatch(s.lines, runScript('try-it.ts').split('\n'), s.numbersVary)).toBeUndefined();
  });

  it('npm run perf: the copy matches a small real run, numbers aside', () => {
    const s = one('npm run perf');
    expect(s.numbersVary).toBe(true);
    let real = runScript('perf-search.ts', ['--skills', '30', '--calls', '5']).split('\n');
    let copy = s.lines;
    if (real.some((l) => l.startsWith('skipped: '))) {
      real = real.filter((l) => !l.startsWith('skipped: '));
      copy = copy.filter((l) => !l.includes('through the MCP server'));
    }
    expect(mismatch(copy, real, true)).toBeUndefined();
  }, 60_000); // a small catalog, but it starts MCP servers: seconds alone, longer beside the whole suite

  it("npm run check: the copy's header is package.json's check script, and its summary is vitest's", () => {
    const s = one('npm run check');
    const real = [`> ${PKG.name}@${PKG.version} check`, `> ${PKG.scripts['check']}`, ' Test Files  1 passed (1)', '      Tests  1 passed | 1 expected fail | 1 skipped (1)'];
    expect(mismatch(s.lines, real, true)).toBeUndefined();
  });

  it('each link to a requirement in docs/requirements.md lands on one of its headings', () => {
    // GitHub's anchor for a heading: lowercased, punctuation dropped (hyphens kept), spaces made hyphens.
    const slug = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
    const page = readFileSync(join(ROOT, 'docs', 'requirements.md'), 'utf8');
    const anchors = new Set([...page.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)).concat([...page.matchAll(/<a id="([^"]+)"/g)].map((m) => m[1]!)));
    const links = [...README.matchAll(/\]\(docs\/requirements\.md#([^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(10);
    for (const a of links) expect(anchors.has(a), `docs/requirements.md#${a}`).toBe(true);
    expect(README, 'requirements are linked by heading, never by a line number').not.toMatch(/\.yaml#L\d/);
  });

  it('each phrase a "You should see" line puts in bold is one the product or its scripts really print', () => {
    // Where the phrases come from: the product's words, the try-it script's run, the perf script and the Claude Code
    // walk-through's script. npm's and vitest's own words are named here, as not ours.
    const NOT_OURS = ['found 0 vulnerabilities', 'Tests', 'failed'];
    const sources = [
      readFileSync(join(import.meta.dirname, '..', 'words', 'words.yaml'), 'utf8'),
      runScript('try-it.ts'),
      readFileSync(join(import.meta.dirname, '..', 'scripts', 'perf-search.ts'), 'utf8'),
      readFileSync(join(ROOT, 'qa', 'try-claude.sh'), 'utf8'),
      ...NOT_OURS,
    ].join('\n');
    // The lines that say what you should see: each "You should see" line, and each row of a table whose second column
    // is headed "You should see" (the Claude Code steps).
    const lines = README.split('\n');
    const tableRows = lines.flatMap((l, i) => (/^\| [^|]+ \| You should see \|$/.test(l) ? lines.slice(i + 2).filter((_, k, rest) => rest.slice(0, k + 1).every((r) => r.startsWith('|'))) : []));
    expect(tableRows.length, 'the Claude Code step table').toBeGreaterThan(4);
    const phrases = [...lines.filter((l) => /You should see/.test(l)), ...tableRows.map((r) => r.split(' | ')[1] ?? '')]
      .flatMap((l) => [...l.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]!))
      .filter((p) => !/^v\d/.test(p)); // the Node.js version: the check above
    expect(phrases.length).toBeGreaterThan(5);
    for (const p of phrases) expect(sources, p).toMatch(new RegExp(pattern(p.replace(/^✓ /, ''), false).source.replace(/^\^|\$$/g, '')));
  });

  it("the PRD table's scenes are try-it's scenes for that PRD item, and every PRD scene is in the table", () => {
    const tags = new Map([...runScript('try-it.ts').matchAll(/^(\d+)\. .*  \[(.+)\]$/gm)].map((m) => [Number(m[1]), m[2]!.toLowerCase()]));
    const at = README.indexOf('## Check it against the PRD');
    const rows = README.slice(at).split('\n').filter((l) => l.startsWith('|')).slice(2); // after the header and |---|
    const named = new Set<number>();
    let n = 0;
    for (const row of rows.slice(0, rows.findIndex((r) => r.startsWith('| PRD |')) >>> 0)) {
      const [item, , where] = row.split(' | ');
      // The row's PRD id: FR-01, UC-02, NFR Consistency, … (a table row's first cell, its marks left out)
      const id = item!.replace(/^\| /, '').replace(/[*↳]/g, '').trim().replace(/:.*$/, '').split(' ').slice(0, /^NFR/.test(item!.replace(/[|*↳ ]/g, '')) ? 2 : 1).join(' ').toLowerCase();
      for (const m of (where ?? '').matchAll(/scenes? ([\d, -]+)/g)) {
        for (const part of m[1]!.split(',').map((x) => x.trim()).filter(Boolean)) {
          const [a, b] = part.split('-').map(Number);
          for (let k = a!; k <= (b ?? a!); k++) {
            expect(tags.get(k), `scene ${k} (the row for ${id})`).toMatch(new RegExp(`^${escape(id)}`));
            named.add(k);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(10);
    for (const [k, tag] of tags) if (tag !== 'beyond the prd') expect(named.has(k), `scene ${k} [${tag}] is in the PRD table`).toBe(true);
  });

  it('each picture is shown full width, and its smallest label is legible on github.com (≥ 9 px in a ~830 px column)', () => {
    // On a phone (a ~358 px column) these pictures' labels are 4-5 px; the system map's pictures replace them (they're
    // built to stay ≥ 9 px there). Open full size: GitHub links each picture to itself.
    const pics = [...README.matchAll(/(<td[^>]*>[^<]*)?<img [^>]*src="(docs\/pictures\/[^"]+\.svg)"[^>]*>|!\[[^\]]*\]\((docs\/pictures\/[^)]+\.svg)\)/g)];
    expect(pics.length).toBeGreaterThan(3);
    for (const m of pics) {
      const file = m[2] ?? m[3]!;
      expect(m[0], file).not.toMatch(/width="(?!100%)[^"]*"/);
      expect(m[1], `${file} sits alone in its row, not in a table cell`).toBeUndefined();
      const svg = readFileSync(join(ROOT, file), 'utf8');
      const width = Number(/viewBox="0 0 ([\d.]+) /.exec(svg)![1]);
      const smallest = Math.min(...[...svg.matchAll(/font-size: *([\d.]+)px/g)].map((f) => Number(f[1])));
      expect((smallest * 830) / width, `${file}: ${width} px wide, smallest label ${smallest} px`).toBeGreaterThanOrEqual(9);
    }
  });

  it("each of the README's pictures uses only the neutral d- prefix for its classes and variables, and has no comments or metadata", () => {
    const dir = join(ROOT, 'docs', 'pictures');
    const svgs = [...new Set([...README.matchAll(/docs\/pictures\/([\w-]+\.svg)/g)].map((m) => m[1]!))];
    expect(svgs.length).toBeGreaterThan(4);
    for (const f of svgs) {
      const svg = readFileSync(join(dir, f), 'utf8');
      const classes = [...svg.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean);
      expect(classes.length, f).toBeGreaterThan(0);
      for (const c of new Set(classes)) expect(c, `${f}: class ${c}`).toMatch(/^d(-|$)/);
      const style = [...svg.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join('\n');
      for (const v of new Set(style.match(/(?<![\w-])--[\w-]+/g) ?? [])) // custom properties, not a class's --modifier expect(v, `${f}: variable ${v}`).toMatch(/^--d-/);
      for (const sel of new Set(style.match(/\.[a-z][\w-]*/gi) ?? [])) expect(sel, `${f}: selector ${sel}`).toMatch(/^\.d(-|$)/);
      expect(svg, `${f} has no comments or metadata`).not.toMatch(/<!--|<metadata|generator/i);
    }
  });

  // The final check found a tool name the README gave that isn't served (preview_skill_publish): every assistant tool
  // the README names is one the words file names.
  it("every assistant tool the README names is one the product serves", async () => {
    const { Words } = await import('../src/words-file.ts');
    const tools = new Set(Object.values(Words.load().names as Record<string, string>));
    const named = [...README.matchAll(/`([a-z]+(?:_[a-z]+){2,})`/g)].map((m) => m[1]!).filter((n) => /skill|catalog|update/.test(n));
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((n) => !tools.has(n))).toEqual([]);
  });

  it("the Node.js version the README asks for is package.json's", () => {
    const min = /^>=(\d+\.\d+)$/.exec(PKG.engines.node)![1]!;
    const named = [...README.matchAll(/Node(?:\.js)? (\d+\.\d+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([min]));
    expect(README).toContain(`node-%E2%89%A5%20${min}`);
  });
});
