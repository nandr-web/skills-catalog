// A page per part of the system map (docs/map/map.yaml `pages:`): what's inside the part, as boxes, and what uses
// what between them. The boxes, their names and places are written by hand; the lines between them are read: inside
// a program, from the imports between the boxes' files (imports.ts); in AWS, from the stack's template (aws.ts). A
// hand-written line only gives words to a line the code has, or joins a box to a part around it that the map one level
// up already links to. The checks here fail when the boxes and the code disagree.
import { matchesGlob } from 'node:path';
import { ACCESS_WORDS, accessWords } from './aws.ts';
import type { Facts } from './facts.ts';
import type { MapSource, Part, Problem, Rule } from './map.ts';

export type Cell = [number, number];
export type Box = {
  id: string; label: string; note?: string; kind?: 'service' | 'store' | 'queue' | 'actor'; at: Cell;
  only?: string[]; status?: 'existing' | 'proposed';
  /** Used by nearly every other box: drawn without lines, and says who uses it (counted from the imports). */
  foundation?: boolean;
  text?: string; code?: string[]; tests?: string[];
  /** AWS resources (logical ids, globs allowed), for a page that reads the stack. */
  resources?: string[];
  /** A planned box: the requirements that would build it. */
  needs?: string[];
};
/** A hand-written line. `over`: not an import but a call over the network (e.g. HTTPS), made by the box's file `via`,
 *  which must be one of the box's files and make a network call (it uses fetch). */
export type Line = { from: string; to: string; label?: string; only?: string[]; over?: string; via?: string };

/** What a file that calls over the network says: it uses fetch, or node's http(s) request. */
const CALLS_OUT = /\bfetch\b|\bhttps?\.request\(/;
export type Page = {
  id: string; parts: string[]; view?: string; title?: string; question: string;
  reads: 'imports' | 'aws'; zone: string;
  /** How far apart the rows and columns are (1 = the renderer's default): more where lines need lanes. */
  spacing?: number;
  context?: { part: string; at: Cell; label?: string }[];
  boxes: Box[]; lines?: Line[];
  /** The part's files that belong to no one box, each with why. */
  shared?: { glob: string; why: string }[];
};
/** The code's packages, with what uses what between them (structure.html, the Code view). */
export type CodeView = { question: string; packages: { id: string; label: string; note?: string; at: Cell; text?: string }[] };

/** A line read from the code between two boxes: which way it goes, and the words the code gives it (AWS access). */
export type ReadLine = { from: string; to: string; both: boolean; words?: string };

/** The densest a page may be and still read at a glance. */
export const PAGE_BUDGET = { boxes: 12, lines: 16 } as const;

const inView = (x: { only?: string[] }, view: string) => !x.only || x.only.includes(view);
const partIn = (p: Part, view: string) => ({ ...p, ...(p.views?.[view] ?? {}) });

/** The views a page is drawn in: its own, or every view its parts appear in. */
export function pageViews(m: MapSource, page: Page): string[] {
  const all = (m.views ?? []).map((v) => v.id);
  if (page.view) return [page.view];
  return all.filter((v) => page.parts.some((id) => { const p = m.parts.find((x) => x.id === id); return p && inView(p, v); }));
}

/** The page a level-0 part opens in a view, if any. */
export function pageOf(m: MapSource, partId: string, view: string): Page | undefined {
  return (m.pages ?? []).find((pg) => pg.parts.includes(partId) && pageViews(m, pg).includes(view));
}

/** The source files a level-0 part owns in a view (its code globs, that view's override first). */
export function partFiles(m: MapSource, facts: Facts, partId: string, view: string): string[] {
  const p = m.parts.find((x) => x.id === partId);
  if (!p) return [];
  const globs = partIn(p, view).code ?? [];
  return facts.sources.filter((f) => globs.some((g) => matchesGlob(f, g)));
}

const boxesIn = (page: Page, view: string) => page.boxes.filter((b) => inView(b, view));
const filesOf = (facts: Facts, b: Box) => facts.sources.filter((f) => (b.code ?? []).some((g) => matchesGlob(f, g)));
const resourcesOf = (facts: Facts, b: Box) => facts.aws.resources.filter((r) => (b.resources ?? []).some((g) => matchesGlob(r.id, g))).map((r) => r.id);

/** The lines the code has between a page's boxes, in a view. */
export function readLines(page: Page, view: string, facts: Facts): ReadLine[] {
  const boxes = boxesIn(page, view).filter((b) => b.status !== 'proposed');
  const lines = new Map<string, { from: string; to: string; ways: Set<string>; words: Set<string> }>();
  const add = (a: string | undefined, b: string | undefined, words = '') => {
    if (!a || !b || a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = `${x}|${y}`;
    const line = lines.get(k) ?? { from: a, to: b, ways: new Set<string>(), words: new Set<string>() };
    line.ways.add(`${a}>${b}`);
    for (const w of words.split(', ').filter(Boolean)) line.words.add(w);
    lines.set(k, line);
  };
  if (page.reads === 'imports') {
    const solid = boxes.filter((b) => !b.foundation);
    const owner = new Map<string, string>();
    for (const b of solid) for (const f of filesOf(facts, b)) if (!owner.has(f)) owner.set(f, b.id);
    for (const e of facts.imports.edges) if (!e.types) add(owner.get(e.from), owner.get(e.to));
  } else {
    const owner = new Map<string, string>();
    for (const b of boxes) for (const r of resourcesOf(facts, b)) if (!owner.has(r)) owner.set(r, b.id);
    for (const r of facts.aws.refs) if (!r.allows) add(owner.get(r.from), owner.get(r.to));
    for (const a of facts.aws.access) add(owner.get(a.from), owner.get(a.to), accessWords(a.actions));
  }
  return [...lines.values()].map((l) => ({
    from: l.from, to: l.to, both: l.ways.size > 1,
    ...(l.words.size ? { words: ACCESS_WORDS.filter((w) => l.words.has(w)).join(', ') } : {}),
  })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Who uses a foundation box: every other box whose files import its files (types too: they shape the code). */
export function foundationUsers(page: Page, box: Box, view: string, facts: Facts): string[] {
  const mine = new Set(filesOf(facts, box));
  return boxesIn(page, view).filter((b) => b.id !== box.id && b.status !== 'proposed').filter((b) => {
    const theirs = new Set(filesOf(facts, b));
    return facts.imports.edges.some((e) => theirs.has(e.from) && mine.has(e.to));
  }).map((b) => b.id);
}

/** Every way the pages and the code disagree. */
export function checkPages(m: MapSource, facts: Facts): Problem[] {
  const problems: Problem[] = [];
  const add = (rule: Rule, message: string) => problems.push({ rule, message });
  const views = new Set((m.views ?? []).map((v) => v.id));
  const parts = new Map(m.parts.map((p) => [p.id, p]));
  const seen = new Map<string, string>(m.parts.map((p) => [p.id, `parts.${p.id}`]));
  const links = m.links ?? [];
  const linked = (a: string, b: string, view: string) => links.some((l) => inView(l, view) && ((l.from === a && l.to === b) || (l.from === b && l.to === a)));

  for (const page of m.pages ?? []) {
    const at = `pages.${page.id}`;
    for (const id of page.parts) if (!parts.has(id)) add('unknown-part', `${at}.parts: no part "${id}" on the map`);
    if (page.view && !views.has(page.view)) add('unknown-view', `${at}.view: no view "${page.view}"`);
    for (const b of page.boxes) {
      if (seen.has(b.id)) add('duplicate-id', `${at}.boxes.${b.id}: the id is already used at ${seen.get(b.id)} (decisions name boxes by id, so each is unique on the map)`);
      seen.set(b.id, `${at}.boxes.${b.id}`);
      for (const v of b.only ?? []) if (!views.has(v)) add('unknown-view', `${at}.boxes.${b.id}.only: no view "${v}"`);
      for (const g of [...(b.code ?? []), ...(b.tests ?? [])]) if (!facts.matches(g).length) add('glob-matches-nothing', `${at}.boxes.${b.id}: "${g}" matches no file`);
      for (const g of b.resources ?? []) if (!facts.aws.resources.some((r) => matchesGlob(r.id, g))) add('glob-matches-nothing', `${at}.boxes.${b.id}.resources: "${g}" matches no resource in the stack's template`);
      if (b.status === 'proposed') {
        if (b.code?.length || b.resources?.length) add('planned-part-has-code', `${at}.boxes.${b.id}: "${b.label}" is planned, but names code or resources: it's built, so drop status: proposed`);
        if (!b.needs?.length) add('planned-needs-nothing', `${at}.boxes.${b.id}: a planned box names the requirements that would build it (needs:)`);
      }
      for (const r of b.needs ?? []) if (!facts.requirements.has(r)) add('unknown-requirement', `${at}.boxes.${b.id}.needs: no requirement "${r}" in qa/traceability.yaml`);
    }
    for (const s of page.shared ?? []) {
      if (!s.why?.trim()) add('left-out-without-why', `${at}.shared: "${s.glob}" says no why`);
      if (!facts.matches(s.glob).length) add('glob-matches-nothing', `${at}.shared: "${s.glob}" matches no file`);
    }
    const context = new Map((page.context ?? []).map((c) => [c.part, c]));
    for (const c of page.context ?? []) if (!parts.has(c.part)) add('unknown-part', `${at}.context: no part "${c.part}" on the map`);

    for (const view of pageViews(m, page)) {
      const vat = `${at} (${view})`;
      const boxes = boxesIn(page, view);
      // Files: every file of the page's parts in exactly one box, or shared with why; no box reaches outside the part.
      const own = new Set(page.parts.flatMap((id) => partFiles(m, facts, id, view)));
      const count = new Map<string, number>();
      for (const b of boxes) for (const f of filesOf(facts, b)) {
        if (!own.has(f)) add('box-file-outside-part', `${vat}: box "${b.id}" names ${f}, which isn't the part's code in this view`);
        count.set(f, (count.get(f) ?? 0) + 1);
      }
      for (const f of own) {
        const shared = (page.shared ?? []).some((s) => matchesGlob(f, s.glob));
        const n = count.get(f) ?? 0;
        if (n === 0 && !shared) add('file-in-no-box', `${vat}: ${f} is in no box: add it to a box's code, or to shared with why`);
        if (n > 1) add('file-in-two-boxes', `${vat}: ${f} is in ${n} boxes: a file belongs to one`);
      }
      // AWS: every resource of the stack in exactly one box.
      if (page.reads === 'aws') for (const r of facts.aws.resources) {
        const n = boxes.filter((b) => (b.resources ?? []).some((g) => matchesGlob(r.id, g))).length;
        if (n === 0) add('resource-in-no-box', `${vat}: the resource ${r.id} (${r.type}) is in no box`);
        if (n > 1) add('resource-in-two-boxes', `${vat}: the resource ${r.id} is in ${n} boxes`);
      }
      // Lines: between two boxes, only on a line the code has; to a part around, only where the map one level up links.
      const read = readLines(page, view, facts);
      const ids = new Set(boxes.map((b) => b.id));
      for (const l of (page.lines ?? []).filter((x) => inView(x, view))) {
        const where = `${vat}.lines ${l.from} → ${l.to}`;
        const ends = [l.from, l.to];
        const unknown = ends.filter((e) => !ids.has(e) && !context.has(e) && !page.boxes.some((b) => b.id === e));
        if (unknown.length) { add('unknown-part', `${where}: no box or part around called ${unknown.join(', ')}`); continue; }
        const inner = ends.filter((e) => ids.has(e));
        if (inner.length === 2) {
          if (!read.some((r) => (r.from === l.from && r.to === l.to) || (r.from === l.to && r.to === l.from)))
            add('line-not-in-code', `${where}: the code has no line between these boxes (${page.reads === 'aws' ? 'no reference or permission' : 'no import'}): a line's words can only sit on one it has`);
          continue;
        }
        if (inner.length === 0) { add('unknown-part', `${where}: a line joins at least one box of this page`); continue; }
        const outside = context.has(l.from) && !ids.has(l.from) ? l.from : l.to;
        if (!page.parts.some((p) => linked(outside, p, view)))
          add('line-not-on-map', `${where}: the map one level up has no link between ${outside} and ${page.parts.join('/')} in this view`);
        const inside = page.boxes.find((b) => b.id === (outside === l.from ? l.to : l.from))!;
        if (page.reads === 'imports' && !l.over) {
          const theirs = new Set(partFiles(m, facts, outside, view));
          const mine = new Set(filesOf(facts, inside));
          if (theirs.size && !facts.imports.edges.some((e) => (mine.has(e.from) && theirs.has(e.to)) || (theirs.has(e.from) && mine.has(e.to))))
            add('line-not-in-code', `${where}: no import between the box's files and ${outside}'s (say over: and via: when they talk over a network)`);
        }
        // Over the network: the box's own file that makes the call, and it does call out.
        if (l.over) {
          const via = l.via ? filesOf(facts, inside).find((f) => f === l.via) : undefined;
          if (!via) add('line-not-in-code', `${where}: over ${l.over} needs via: the file of "${inside.id}" that makes the call (${l.via ? `${l.via} isn't one of its files` : 'none named'})`);
          else if (!CALLS_OUT.test(facts.text(via))) add('line-not-in-code', `${where}: ${via} makes no network call (no fetch or http request)`);
        }
      }
      const drawn = read.length + (page.lines ?? []).filter((l) => inView(l, view) && (context.has(l.from) || context.has(l.to))).length;
      if (boxes.length > PAGE_BUDGET.boxes) add('too-dense', `${vat}: ${boxes.length} boxes (at most ${PAGE_BUDGET.boxes}): group some, or give one a page of its own`);
      if (drawn > PAGE_BUDGET.lines) add('too-dense', `${vat}: ${drawn} lines (at most ${PAGE_BUDGET.lines}): group boxes, or mark one that nearly everything uses as a foundation`);
    }
  }
  return problems;
}

/** Checks the Code view: every package of the system has a box (qa is the checks, off the map). */
export function checkCodeView(code: CodeView | undefined, packages: readonly string[]): Problem[] {
  if (!code) return [];
  const shown = new Set(code.packages.map((p) => p.id));
  return packages.filter((p) => p !== 'qa' && !shown.has(p)).map((p) => ({ rule: 'package-not-shown' as const, message: `code.packages: the package ${p} has no box` }));
}

/** The lines between packages: any import (types included: a package needs the other to build). */
export function packageLines(facts: Facts, packages: readonly string[]): ReadLine[] {
  const pkg = (f: string) => f.split('/')[0]!;
  const ways = new Map<string, Set<string>>();
  for (const e of facts.imports.edges) {
    const a = pkg(e.from), b = pkg(e.to);
    if (a === b || !packages.includes(a) || !packages.includes(b)) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    ways.set(k, (ways.get(k) ?? new Set()).add(`${a}>${b}`));
  }
  return [...ways].map(([, w]) => {
    const [a, b] = [...w][0]!.split('>') as [string, string];
    return { from: a, to: b, both: w.size > 1 };
  }).sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}
