// The system map's pages (docs/map/*.html), built from the map, the decision log and the facts read from the code:
//   index.html       the architecture at a high level (architecture.ts overview:): who uses it on top, the contracts
//                    in the middle with one box per side beside them, planned parts hatched with their phase
//   <zoom>.html      one level down (zooms:): the ports, and what plugs into each on one machine and in AWS
//   use-cases.html   use cases: the core loop, step by step (the renderer's own page, with the site's navigation)
//   context.html     who uses it and where each copy runs: the running parts (on one machine, in AWS; planned parts on
//                    a toggle) and its code's packages, with what uses what
//   decisions.html   every decision, with the parts it's about, and the options weighed where there were several
//   <page>.html      a part's insides (pages.ts): where it sits, its boxes and the lines read between them, its
//                    decisions, the use-case steps through it, its code and tests
// One question per page. Self-contained: inline CSS and script; without a script everything is still there, stacked.
import { matchesGlob } from 'node:path';
import { architectureSpec, landingSpec, phaseOf, UNPROVEN, unprovenContract, zoomBoxes, type ArchBox, type OverviewBox, type Zoom } from './architecture.ts';
import { decisionsAbout, type Aspect, type Decision, type DecisionLog } from './decisions.ts';
import type { Facts } from './facts.ts';
import { toSpec, type MapSource, type Part } from './map.ts';
import { foundationUsers, packageLines, pageOf, pageViews, partFiles, readLines, type Box, type Page } from './pages.ts';
import { buildSystemMapFrom, diagramCss, drawSystemMap, fonts, layoutSystemMap, parseSystemMap, scrollHintCss, wrapWide, type SystemMapSpec } from './renderer.js';

export const MAP_DIR = 'docs/map';
export type SiteOptions = { static?: boolean };
type Ctx = { m: MapSource; facts: Facts; log: DecisionLog; codeBase: string; script: boolean };

// ---------------------------------------------------------------- small helpers

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Text with `backticks` shown as code, and [links](to.md) as links (relative ones are docs/'s, one folder up). */
const rich = (t: string) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => `<a href="${/^(https?:|#|\/)/.test(href) ? href : `../${href}`}">${text}</a>`);
const inView = (x: { only?: string[] }, view: string) => !x.only || x.only.includes(view);
const partIn = (p: Part, view: string) => ({ ...p, ...(p.views?.[view] ?? {}) }) as Part;
const viewLabel = (m: MapSource, v: string) => m.views?.find((x) => x.id === v)?.label ?? v;
const codeLink = (c: Ctx, path: string) => `<a href="${esc(c.codeBase + path.replace(/[*{].*$/, '').replace(/\/$/, ''))}"><code>${esc(path)}</code></a>`;

/** Every id on the map (parts, boxes, packages) → the page and anchor that shows it. */
function where(c: Ctx): Map<string, { href: string; label: string }> {
  const out = new Map<string, { href: string; label: string }>();
  const views = (c.m.views ?? []).map((v) => v.id);
  for (const p of c.m.parts) {
    const pg = views.map((v) => pageOf(c.m, p.id, v)).find(Boolean);
    out.set(p.id, { href: pg ? `${pg.id}.html` : `context.html#part=${p.id}`, label: p.label });
  }
  for (const pg of c.m.pages ?? []) for (const b of pg.boxes) out.set(b.id, { href: `${pg.id}.html#box=${b.id}`, label: `${b.label} (${pageTitle(c.m, pg)})` });
  return out;
}
export const pageTitle = (m: MapSource, pg: Page) => pg.title ?? m.parts.find((p) => p.id === pg.parts[0])?.label ?? pg.id;

// ---------------------------------------------------------------- the specs the renderer draws

/** The map one level up: every part (planned ones too, if asked), no flows; parts with a page link to it. */
function overviewSpec(c: Ctx, opts: { planned: boolean; focus?: string[] }): SystemMapSpec {
  const spec = toSpec(c.m, c.facts, MAP_DIR) as Record<string, any>;
  const planned = new Set(c.m.parts.filter((p) => p.status === 'proposed').map((p) => p.id));
  if (!opts.planned) {
    spec.parts = spec.parts.filter((p: any) => !planned.has(p.id));
    spec.links = spec.links.filter((l: any) => !planned.has(l.from) && !planned.has(l.to));
  }
  if (opts.focus) for (const p of spec.parts) if (opts.focus.includes(p.id)) p.emphasis = 'focus';
  spec.flows = [];
  return parseSystemMap(spec).spec;
}

/** The spec for the use-case page: the parts built today, the flows. */
export function useCaseSpec(c: Pick<Ctx, 'm' | 'facts'>): Record<string, unknown> {
  const spec = toSpec(c.m, c.facts, MAP_DIR) as Record<string, any>;
  const planned = new Set(c.m.parts.filter((p) => p.status === 'proposed').map((p) => p.id));
  spec.parts = spec.parts.filter((p: any) => !planned.has(p.id));
  spec.links = spec.links.filter((l: any) => !planned.has(l.from) && !planned.has(l.to));
  return spec;
}

/** The lines a page draws in a view: read from the code (words from a hand line, or from the code), and to the parts around. */
function pageLinks(c: Ctx, page: Page, views: string[]) {
  const context = new Set((page.context ?? []).map((x) => x.part));
  const links = new Map<string, { from: string; to: string; label?: string; arrow: string; only: string[] }>();
  for (const v of views) {
    for (const r of readLines(page, v, c.facts)) {
      const hand = (page.lines ?? []).find((l) => inView(l, v) && ((l.from === r.from && l.to === r.to) || (l.from === r.to && l.to === r.from)));
      const k = [r.from, r.to].sort().join('|');
      const label = hand?.label ?? r.words;
      const had = links.get(k);
      if (had) had.only.push(v);
      else links.set(k, { from: r.from, to: r.to, ...(label ? { label } : {}), arrow: r.both ? 'both' : 'forward', only: [v] });
    }
    for (const l of (page.lines ?? []).filter((x) => inView(x, v) && (context.has(x.from) || context.has(x.to)))) {
      const k = [l.from, l.to].sort().join('|');
      const had = links.get(k);
      if (had) had.only.push(v);
      else links.set(k, { from: l.from, to: l.to, label: l.label, arrow: 'forward', only: [v] });
    }
  }
  return [...links.values()].map((l) => (l.only.length === views.length ? { ...l, only: undefined } : l));
}

/** A part's page as a map: the parts around it (outside its boundary) and its boxes (inside). */
function insideSpec(c: Ctx, page: Page): SystemMapSpec {
  const views = pageViews(c.m, page);
  const many = views.length > 1;
  const parts: any[] = [];
  for (const x of page.context ?? []) {
    const p = c.m.parts.find((q) => q.id === x.part)!;
    const per = Object.fromEntries(views.map((v) => {
      const pv = partIn(p, v), pg = pageOf(c.m, p.id, v);
      return [v, { label: x.label ?? pv.label, ...(pv.note ? { note: pv.note } : {}), ...(pg ? { href: `${pg.id}.html` } : {}) }];
    }));
    const first = per[views[0]!]!;
    parts.push({
      id: x.part, label: first.label, ...(first.note ? { note: first.note } : {}), kind: p.kind ?? 'service', external: !!p.external, at: x.at,
      ...(many ? { views: per } : first.href ? { href: first.href } : {}),
    });
  }
  for (const b of page.boxes) parts.push({
    id: b.id, label: b.label, ...(b.note ? { note: b.note } : {}), kind: b.kind ?? 'service', at: b.at, zone: 'inside',
    ...(b.status === 'proposed' ? { status: 'proposed', ...(phaseOf(b, c.facts) ? { phase: phaseOf(b, c.facts) } : {}) } : {}),
    ...(b.only && many ? { only: b.only.filter((v) => views.includes(v)) } : {}),
  });
  const links = pageLinks(c, page, views);
  return parseSystemMap({
    kind: 'system-map', title: pageTitle(c.m, page), question: page.question, alertWord: 'waits',
    ...(page.spacing ? { spacing: page.spacing } : {}),
    views: many ? views.map((v) => ({ id: v, label: viewLabel(c.m, v) })) : [],
    zones: [{ id: 'inside', label: page.zone }],
    parts, links: links.map((l) => (many ? l : { ...l, only: undefined })), flows: [],
  }).spec;
}

/** The Code view: the packages, and which uses which. */
function codeSpec(c: Ctx): SystemMapSpec {
  const code = c.m.code!;
  const shown = code.packages.map((p) => p.id);
  return parseSystemMap({
    kind: 'system-map', title: 'The code', question: code.question,
    parts: code.packages.map((p) => ({ id: p.id, label: p.label, ...(p.note ? { note: p.note } : {}), at: p.at })),
    links: packageLines(c.facts, shown).map((l) => ({ from: l.from, to: l.to, label: 'uses', arrow: l.both ? 'both' : 'forward' })),
    flows: [],
  }).spec;
}

// ---------------------------------------------------------------- pieces of HTML

function nav(current: 'architecture' | 'use-cases' | 'context' | 'decisions' | 'part', crumbs: { label: string; href?: string }[] = []): string {
  const tab = (id: string, href: string, label: string) => `<a href="${href}"${current === id || (id === 'architecture' && current === 'part') ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="site" aria-label="The system map's pages">
<a class="brand" href="index.html">Skills Catalog · system map</a>
<span class="tabs">${tab('architecture', 'index.html', 'Architecture')}${tab('use-cases', 'use-cases.html', 'Use cases')}${tab('context', 'context.html', 'Context')}${tab('decisions', 'decisions.html', 'Decisions')}</span>
</nav>${crumbs.length ? `\n<p class="crumbs">${crumbs.map((x) => (x.href ? `<a href="${esc(x.href)}">${esc(x.label)}</a>` : `<span aria-current="page">${esc(x.label)}</span>`)).join(' <span aria-hidden="true">›</span> ')}</p>` : ''}`;
}

const VERDICT: Record<string, string> = { good: '+', even: '=', poor: '−', unknown: '?' };
const VERDICT_WORD: Record<string, string> = { good: 'counts for it', even: 'neither for nor against', poor: 'counts against it', unknown: 'not known when it was weighed' };

/** An aspect weighed side by side: options across, what drives the choice down, each cell a fact and a mark. `open`:
 *  shown at once (a box's own choice), not folded under its decision. */
function matrix(a: Aspect, open = false): string {
  const chosen = a.options.find((o) => o.id === a.chosen);
  const head = a.options.map((o) => `<th scope="col" class="${o.id === a.chosen ? 'chosen' : ''}">${esc(o.label)}${o.id === a.chosen ? ' <span class="tag chosen-tag">chosen</span>' : ''}${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</th>`).join('');
  const rows = a.drivers.map((d) => {
    const toward = a.options.find((o) => o.id === d.toward);
    return `<tr><th scope="row">${esc(d.name)}${toward ? `<span class="sub">favours ${esc(toward.label)}</span>` : ''}</th>${a.options.map((o) => {
      const cell = d.cells[o.id];
      if (!cell) return `<td class="${o.id === a.chosen ? 'chosen' : ''}"></td>`;
      const v = cell.v ?? '';
      return `<td class="${[v ? `v-${v}` : '', o.id === a.chosen ? 'chosen' : ''].filter(Boolean).join(' ')}">${v ? `<span class="mark" title="${VERDICT_WORD[v]}" aria-label="${VERDICT_WORD[v]}">${VERDICT[v]}</span> ` : ''}${esc(cell.t)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const others = a.options.filter((o) => o.id !== a.chosen && o.id !== 'today').map((o) => o.label);
  return `<details class="aspect"${open ? ' open' : ''}><summary><strong>${esc(a.title)}</strong>: ${chosen ? `<span class="pick">${esc(chosen.label)}</span>, chosen over ${others.map(esc).join(', ')}` : 'still open'}</summary>
${a.note ? `<p class="aspect-note"><span class="kicker">Since</span> ${rich(a.note)}</p>` : ''}
<div class="matrix-wrap"><table class="matrix"><thead><tr><th scope="col">What drives it</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
<p class="legend-line"><span class="mark">+</span> counts for it · <span class="mark">=</span> neither · <span class="mark">−</span> counts against it${a.drivers.some((d) => Object.values(d.cells).some((x) => x.v === 'unknown')) ? ' · <span class="mark">?</span> not known when it was weighed' : ''}</p></details>`;
}

/**
 * A box's own choice, for a card too narrow for the table: the chosen option first, with what counts for and against
 * it; each alternative folded, with its tally; what's built today on one machine last. The table, every option side by
 * side, is on the decisions page.
 */
function choiceList(a: Aspect, decisionId: string): string {
  const chosen = a.options.find((o) => o.id === a.chosen);
  const facts = (id: string) => a.drivers.map((d) => {
    const c = d.cells[id];
    if (!c) return '';
    const v = c.v ?? '';
    return `<li${v ? ` class="v-${v}"` : ''}>${v ? `<span class="mark" title="${VERDICT_WORD[v]}" aria-label="${VERDICT_WORD[v]}">${VERDICT[v]}</span> ` : ''}<strong>${esc(d.name)}</strong>: ${esc(c.t)}</li>`;
  }).join('');
  const tally = (id: string) => {
    const n = (v: string) => a.drivers.filter((d) => d.cells[id]?.v === v).length;
    const parts = [['good', 'for'], ['even', 'neither'], ['poor', 'against'], ['unknown', 'not known']].filter(([v]) => n(v!)).map(([v, w]) => ({ mark: `${VERDICT[v!]}${n(v!)}`, words: `${n(v!)} ${w}` }));
    return parts.length ? ` <span class="tally" aria-label="${parts.map((p) => p.words).join(', ')}">${parts.map((p) => p.mark).join(' ')}</span>` : '';
  };
  const option = (o: Aspect['options'][number], open: boolean, prefix = '') =>
    `<details class="option${open ? ' picked-option' : ''}"${open ? ' open' : ''}><summary>${open ? '<span class="tag chosen-tag">chosen</span> ' : ''}${prefix}<strong>${esc(o.label)}</strong>${o.sub ? ` <span class="sub">${esc(o.sub)}</span>` : ''}${tally(o.id)}</summary><ul class="facts">${facts(o.id)}</ul></details>`;
  const others = a.options.filter((o) => o.id !== a.chosen && o.id !== 'today');
  const today = a.options.find((o) => o.id === 'today');
  return `<div class="choice"><span class="kicker">The choice</span>
<p><strong>${esc(a.title)}</strong>: ${chosen ? `<span class="pick">${esc(chosen.label)}</span>, chosen over ${others.map((o) => esc(o.label)).join(', ')}` : 'still open'}</p>
${a.note ? `<p class="aspect-note"><span class="kicker">Since</span> ${rich(a.note)}</p>` : ''}
${chosen ? option(chosen, true) : ''}
${others.map((o) => option(o, false)).join('')}
${today ? option(today, false, 'Built today: ') : ''}
<p><a href="decisions.html#decision-${esc(decisionId)}">Every option side by side ›</a></p>
</div>`;
}

/**
 * One decision: a line to scan (its number, what was decided, built or not) that opens to the rest: over what, why,
 * who and when, the parts it's about, and the options weighed side by side where there were several.
 */
function decisionCard(c: Ctx, d: Decision, opts: { aspects?: Aspect[]; chips?: boolean; id?: boolean } = {}): string {
  const w = where(c);
  // Built, not yet, partly (built with a part still to come), or nothing to build (—).
  const built = /^Not built/.test(d.built) ? 'not-built' : /^Yes$/.test(d.built) ? 'built' : /^[—-]$/.test(d.built.trim()) ? 'other' : /^Yes/.test(d.built) ? 'built' : 'partly';
  const chips = opts.chips !== false && d.parts?.length
    ? `<p class="about"><span class="kicker">About</span> ${d.parts.map((p) => { const x = w.get(p); return x ? `<a class="chip" href="${esc(x.href)}">${esc(x.label)}</a>` : ''; }).join(' ')}</p>` : '';
  const aspects = opts.aspects ?? d.aspects ?? [];
  // A lead followed by punctuation ("Bundles of skills, with …") reads as one sentence.
  const sentence = d.title && /^[,.;:]/.test(d.text) ? `${d.title}${d.text}` : d.text;
  return `<details class="decision decision-${built}"${opts.id === false ? '' : ` id="decision-${esc(d.id)}"`}>
<summary><span class="did">${esc(d.id)}</span> <span class="what">${d.title ? esc(d.title.replace(/:$/, '')) : rich(d.text)}</span> <span class="built built-${built}">${{ built: 'built', 'not-built': 'not built yet', partly: 'partly built', other: 'nothing to build' }[built]}</span></summary>
<div class="body">
${d.title ? `<p>${rich(sentence)}</p>` : ''}
${d.over?.length ? `<p class="over"><span class="kicker">Chosen over</span> ${d.over.map((o) => `<span class="alt">${rich(o)}</span>`).join('')}</p>` : ''}
<p class="why"><span class="kicker">Why</span> ${rich(d.rationale)}</p>
${d.honours ? `<p class="why"><span class="kicker">How the build honours it</span> ${rich(d.honours)}</p>` : ''}
<p class="meta">${esc(d.by)} · ${esc(d.date)}${built !== 'built' || /^Yes,/.test(d.built) ? ` · ${rich(d.built)}` : ''}</p>
${chips}
${aspects.map((a) => matrix(a)).join('\n')}
</div>
</details>`;
}

// ---------------------------------------------------------------- the page shell

const PAGE_CSS = `
:root { --page: #ECF0F3; --card: #F9FBFC; --ink: #13202A; --ink-2: #3A4A56; --line: #B7C4CD; --accent: #137052; --accent-soft: #D9EDE3; --hot: #B23A0A; --hot-soft: #F8E2D5; --even: #E4E9ED; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page: #0E1418; --card: #151D23; --ink: #E3EAEE; --ink-2: #AFBCC5; --line: #3A4A55;
  --accent: #46C290; --accent-soft: #1C3A2F; --hot: #F08A50; --hot-soft: #4A2819; --even: #26313A; color-scheme: dark; } }
:root[data-theme="dark"] { --page: #0E1418; --card: #151D23; --ink: #E3EAEE; --ink-2: #AFBCC5; --line: #3A4A55; --accent: #46C290; --accent-soft: #1C3A2F; --hot: #F08A50; --hot-soft: #4A2819; --even: #26313A; color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--page); color: var(--ink); font: 16px/1.5 ${fonts.sans}; margin: 0; padding: 0 20px 56px; }
.wrap { max-width: 1080px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
h1, h2, h3 { font-family: ${fonts.cond}; margin: 0; text-wrap: balance; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
code { font: 13px ${fonts.mono}; background: var(--page); padding: 1px 5px; border-radius: 3px; overflow-wrap: anywhere; }
nav.site { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; padding-top: 14px; }
nav.site .brand { font: 600 12px ${fonts.mono}; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); text-decoration: none; }
nav.site .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
nav.site .tabs a { font: 600 14px ${fonts.sans}; color: var(--ink); text-decoration: none; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); }
nav.site .tabs a[aria-current="page"] { background: var(--ink); color: var(--card); border-color: var(--ink); }
.crumbs { margin: 0; font-size: 14px; color: var(--ink-2); }
.crumbs a { font-weight: 600; }
header.top { padding-block: 10px 12px; border-bottom: 1.5px solid var(--ink); display: grid; gap: 6px; }
.eyebrow, .kicker { font: 600 11px ${fonts.mono}; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); }
h1 { font-size: clamp(30px, 5vw, 44px); line-height: 1.05; font-weight: 700; letter-spacing: -0.02em; }
.question { font-size: 18px; max-width: 62ch; margin: 0; }
.lede { margin: 0; max-width: 70ch; color: var(--ink-2); }
.controls { display: none; flex-wrap: wrap; gap: 10px 16px; align-items: center; position: sticky; top: env(safe-area-inset-top, 0px); z-index: 2; background: var(--page); padding-block: 10px; border-bottom: 1px solid var(--line); }
.js .controls { display: flex; }
.controls button { font: 500 14px ${fonts.sans}; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; cursor: pointer; min-height: 34px; }
.controls button[aria-pressed="true"] { background: var(--ink); color: var(--card); border-color: var(--ink); font-weight: 600; }
.controls .switch[aria-pressed="true"] { background: var(--accent-soft); color: var(--ink); border: 1.5px dashed var(--accent); }
.seg { display: flex; gap: 6px; flex-wrap: wrap; }
.frame { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 16px; display: grid; gap: 10px; }
.js .frame { display: none; }
.js .frame.on { display: grid; }
.frame-title { font: 600 15px ${fonts.mono}; color: var(--ink-2); letter-spacing: .02em; }
.frame-grid { display: grid; grid-template-columns: minmax(0, max-content) minmax(240px, 1fr); gap: 20px; align-items: start; }
.map-art { margin: 0; min-width: 0; width: var(--w); max-width: 100%; }
.panel { display: grid; gap: 10px; font-size: 15px; align-content: start; }
.panel h3 { font-size: 20px; font-weight: 600; }
.panel p, .card p, .decision p { margin: 0; }
.hint { color: var(--ink-2); font-size: 14px; font-style: italic; }
.legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 14px; color: var(--ink-2); }
.legend b { color: var(--ink); font-family: ${fonts.mono}; font-size: 13px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; display: grid; gap: 6px; align-content: start; font-size: 15px; min-width: 0; }
.panel, .card > *, .decision, .decision > .body > *, .choice, details.aspect { min-width: 0; }
.card h3 { font-size: 18px; font-weight: 600; }
.card .note { color: var(--ink-2); font: 13px ${fonts.mono}; }
.card ul { margin: 0; padding-left: 18px; }
.picked .card { position: relative; border: 2.5px solid var(--ink); padding-right: 92px; }
.picked .close { position: absolute; top: 10px; right: 10px; font: 600 12px ${fonts.mono}; color: var(--ink); background: var(--page); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; cursor: pointer; }
.cards { display: grid; gap: 10px; }
.cards > h2, section > h2 { font-size: 22px; font-weight: 600; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.js .cards.boxes { display: none; }
.tag { font: 600 10.5px ${fonts.mono}; letter-spacing: .06em; text-transform: uppercase; border: 1px dashed var(--ink); border-radius: 3px; padding: 1px 5px; vertical-align: 2px; color: var(--ink); }
.chosen-tag { border: 1.5px solid var(--accent); color: var(--accent); }
.where-it-sits { display: grid; gap: 6px; }
.locators { display: flex; flex-wrap: wrap; gap: 12px; }
.locator { margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; flex: 0 1 auto; min-width: 0; max-width: 100%; }
.locator figcaption { font: 600 12px ${fonts.mono}; color: var(--ink-2); }
section { display: grid; gap: 10px; }
section > *, .frame > *, .frame-grid > * { min-width: 0; }
.steps-through { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.steps-through li { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start; }
.num { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: var(--accent); color: var(--card); font: 600 11px ${fonts.mono}; }
.decisions { display: grid; gap: 6px; }
.decision { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 6px; font-size: 15px; }
.decision.decision-not-built { border-left-style: dashed; border-left-color: var(--ink-2); }
.decision > summary { cursor: pointer; padding: 8px 12px; display: flex; gap: 10px; align-items: baseline; list-style: none; }
.decision > summary::-webkit-details-marker { display: none; }
.decision > summary::before { content: '▸'; color: var(--ink-2); font-size: 12px; }
.decision[open] > summary::before { content: '▾'; }
.decision > summary .what { flex: 1 1 auto; font-family: ${fonts.cond}; font-size: 17px; font-weight: 600; }
.decision > .body { padding: 0 14px 12px 32px; display: grid; gap: 6px; }
.decision:target { outline: 3px solid var(--accent); outline-offset: 2px; }
.choice { display: grid; gap: 4px; border-top: 1px solid var(--line); padding-top: 6px; }
.choice details.aspect { border-top: 0; padding-top: 0; }
.pick { font-weight: 700; color: var(--accent); }
details.option { border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; }
details.option.picked-option { border: 2px solid var(--accent); background: var(--accent-soft); }
details.option > summary { cursor: pointer; }
details.option .sub { color: var(--ink-2); font-size: 13px; }
.tally { font: 600 12px ${fonts.mono}; color: var(--ink-2); white-space: nowrap; }
ul.facts { list-style: none; margin: 6px 0 2px; padding: 0; display: grid; gap: 3px; font-size: 14px; }
ul.facts li { padding: 2px 6px; border-radius: 3px; }
ul.facts li.v-good { background: var(--accent-soft); }
ul.facts li.v-poor { background: var(--hot-soft); }
ul.facts li.v-even, ul.facts li.v-unknown { background: var(--even); }
.did { font: 600 12px ${fonts.mono}; color: var(--ink-2); }
.built { font: 600 10.5px ${fonts.mono}; letter-spacing: .06em; text-transform: uppercase; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--line); color: var(--ink-2); }
.built-built { border-color: var(--accent); color: var(--accent); }
.built-not-built { border-style: dashed; border-color: var(--ink); color: var(--ink); }
.built-partly { border-color: var(--accent); color: var(--ink); border-style: dashed; }
.decision.not-built-yet { border-left-style: dashed; }
.over .alt { display: inline-block; margin: 2px 6px 2px 0; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 14px; color: var(--ink-2); text-decoration: line-through; text-decoration-color: var(--line); }
.why { color: var(--ink); }
.meta { color: var(--ink-2); font-size: 14px; }
.about { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chip { font-size: 13px; font-weight: 600; text-decoration: none; padding: 2px 9px; border-radius: 999px; background: var(--accent-soft); color: var(--ink); border: 1px solid var(--accent); }
.chip:hover { text-decoration: underline; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.open-questions { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.open-questions li { background: var(--card); border: 1px dashed var(--ink-2); border-radius: 6px; padding: 8px 12px; }
.js .decisions .decision.out { display: none; }
details.aspect { border-top: 1px solid var(--line); padding-top: 6px; }
details.aspect summary { cursor: pointer; }
.matrix-wrap { overflow-x: auto; margin-top: 8px; }
table.matrix { border-collapse: collapse; font-size: 13px; min-width: 640px; }
.matrix th, .matrix td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
.matrix thead th { font-family: ${fonts.cond}; font-size: 14px; }
.matrix .sub { display: block; font: 400 12px ${fonts.sans}; color: var(--ink-2); }
.matrix th.chosen, .matrix td.chosen { border-left: 2.5px solid var(--accent); border-right: 2.5px solid var(--accent); }
.matrix thead th.chosen { border-top: 2.5px solid var(--accent); background: var(--accent-soft); }
.matrix td.v-good { background: var(--accent-soft); }
.matrix td.v-poor { background: var(--hot-soft); }
.matrix td.v-even { background: var(--even); }
.mark { font: 700 13px ${fonts.mono}; }
.legend-line { font-size: 13px; color: var(--ink-2); margin: 6px 0 0; }
.aspect-note { margin: 6px 0 0; padding: 6px 10px; border-left: 3px solid var(--hot); background: var(--hot-soft); font-size: 14px; }
.hide-planned .d-map-part--proposed, .hide-planned .d-edge--proposed, .hide-planned .d-edge-label--proposed, .hide-planned .planned-only { display: none; }
.frame-grid.wide { grid-template-columns: minmax(0, 1fr); }
@media (max-width: 760px) { .frame-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 560px) { body { padding-inline: 16px; font-size: 15px; } .frame { padding: 12px; } }
`;

/** The script for the structure page and the parts' pages: which view, planned or not, which box is picked. */
const SCRIPT = `(() => {
  const root = document.documentElement, data = JSON.parse(document.getElementById('page-data').textContent);
  root.classList.add('js');
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const state = { view: data.views[0], sv: data.svs[0], planned: false, box: '' };
  const card = (box) => document.querySelector('.cards.boxes .card[data-box="' + box + '"][data-view="' + state.view + '"]')
    || document.querySelector('.cards.boxes .card[data-box="' + box + '"]');
  function read() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (data.views.includes(h.get('view'))) state.view = h.get('view');
    if (data.svs.includes(h.get('sv'))) state.sv = h.get('sv');
    state.planned = h.get('planned') === '1';
    const box = h.get('box') || h.get('part') || '';
    state.box = box && card(box) ? box : '';
    if (state.box && data.svOf && data.svOf[state.box]) state.sv = data.svOf[state.box];
  }
  function write() {
    const h = new URLSearchParams();
    if (state.view !== data.views[0]) h.set('view', state.view);
    if (state.sv !== data.svs[0]) h.set('sv', state.sv);
    if (state.planned) h.set('planned', '1');
    if (state.box) h.set('box', state.box);
    const s = h.toString();
    history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
  }
  function show() {
    root.classList.toggle('hide-planned', !state.planned && !data.planned);
    let active = null;
    for (const f of $$('.frame')) {
      const on = (!f.dataset.view || f.dataset.view === state.view) && (!f.dataset.sv || f.dataset.sv === state.sv)
        && (!f.dataset.planned || f.dataset.planned === (state.planned ? '1' : '0'));
      f.classList.toggle('on', on);
      if (on && !active) active = f;
      const slot = f.querySelector('.picked');
      if (slot) { slot.hidden = true; slot.replaceChildren(); }
    }
    for (const b of $$('.controls [data-view]')) { b.setAttribute('aria-pressed', String(b.dataset.view === state.view)); b.hidden = !!(b.dataset.forSv && b.dataset.forSv !== state.sv); }
    for (const b of $$('.controls [data-sv]')) b.setAttribute('aria-pressed', String(b.dataset.sv === state.sv));
    for (const b of $$('.controls [data-planned]')) { b.setAttribute('aria-pressed', String(state.planned)); b.hidden = !!(b.dataset.forSv && b.dataset.forSv !== state.sv); }
    for (const g of $$('.d-map-part')) g.classList.toggle('d-map-part--picked', !!state.box && g.dataset.part === state.box);
    const src = state.box && card(state.box);
    if (src && active) {
      const slot = active.querySelector('.picked');
      const c = src.cloneNode(true);
      c.removeAttribute('id');
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'close'; close.textContent = 'Close ✕'; close.setAttribute('aria-label', 'Close');
      close.addEventListener('click', () => go({ box: '' }));
      c.prepend(close);
      slot.append(c); slot.hidden = false;
    }
  }
  function go(change) { Object.assign(state, change); write(); show(); }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.controls [data-view], .controls [data-sv], .controls [data-planned], .d-map-part[role="button"]');
    if (!t) return;
    if (t.matches('.d-map-part')) {
      go({ box: state.box === t.dataset.part ? '' : t.dataset.part });
      // A card shown under a wide drawing is below the fold: bring it into view.
      const shown = document.querySelector('.frame.on .picked:not([hidden])');
      if (shown) shown.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    e.preventDefault();
    if (t.dataset.sv !== undefined) return go({ sv: t.dataset.sv, box: '' });
    if (t.dataset.view !== undefined) return go({ view: t.dataset.view });
    if (t.dataset.planned !== undefined) return go({ planned: !state.planned });
  });
  document.addEventListener('keydown', (e) => {
    const part = e.target && e.target.closest && e.target.closest('.d-map-part[role="button"]');
    if (part && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); return go({ box: part.dataset.part }); }
    if (e.key === 'Escape' && state.box) go({ box: '' });
  });
  window.addEventListener('hashchange', () => { read(); show(); });
  read(); show();
  // A page whose drawing is centred on what matters (the contracts): a narrow screen opens on the middle of it.
  if (data.center) for (const s of $$('.frame.on .d-scroll-art')) if (s.scrollWidth > s.clientWidth) s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2;
})();`;

function shell(title: string, body: string, opts: { css?: string; data?: unknown; script: boolean; extra?: string }): string {
  const json = opts.data ? JSON.stringify(opts.data).replace(/</g, '\\u003c') : '';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts.googleCss}">
<style>
${diagramCss()}
${PAGE_CSS}
${opts.css ?? ''}
</style>
<div class="wrap">
${body}
</div>
${opts.script && opts.data ? `<script type="application/json" id="page-data">${json}</script>\n<script>${SCRIPT}</script>` : ''}${opts.script && opts.extra ? `<script>${opts.extra}</script>` : ''}
`;
}

/** A drawing wider than a desktop column leaves for it gets the whole width, with its panel under it. */
const gridClass = (width: number) => (width > 720 ? 'frame-grid wide' : 'frame-grid');

/** A drawing on a page: inline, wrapped so a wide one scrolls sideways and says so. */
function figure(svg: string, widths: number[], w: number): string {
  const { html, width } = wrapWide(svg);
  if (width) widths.push(width);
  return `<figure class="map-art" style="--w: ${w}px">${html}</figure>`;
}

// ---------------------------------------------------------------- the pages

/** A level-0 part's card on the structure page (for the parts that have no page of their own, and the packages). */
function partCard(c: Ctx, p: Part, view: string): string {
  const x = partIn(p, view);
  const pg = pageOf(c.m, p.id, view);
  const about = decisionsAbout(c.log, p.id);
  return `<article class="card" data-box="${esc(p.id)}" data-view="${esc(view)}">
<h3>${esc(x.label)}${p.status === 'proposed' ? ' <span class="tag">planned</span>' : ''}${p.external ? ' <span class="tag">not ours</span>' : ''}</h3>
${x.note ? `<p class="note">${esc(x.note)}</p>` : ''}
${x.text ? `<p>${rich(x.text)}</p>` : ''}
${pg ? `<p><a href="${pg.id}.html"><strong>Inside ${esc(x.label)} ›</strong></a></p>` : ''}
${p.needs?.length ? `<p><span class="kicker">Would be built by</span> ${p.needs.map((r) => { const q = c.facts.requirements.get(r); return q ? `<a href="${esc(c.codeBase)}qa/traceability.yaml#L${q.line}" title="${esc(q.text)}"><code>${esc(r)}</code></a>` : `<code>${esc(r)}</code>`; }).join(' ')}</p>` : ''}
${about.length ? `<p><span class="kicker">Decisions</span> ${about.map(({ decision: d }) => `<a href="decisions.html#decision-${esc(d.id)}">${esc(d.id)}${d.title ? ` ${esc(d.title.replace(/:$/, ''))}` : ''}</a>`).join(' · ')}</p>` : ''}
</article>`;
}

async function contextPage(c: Ctx): Promise<string> {
  const views = (c.m.views ?? []).map((v) => v.id);
  const widths: number[] = [];
  // Two drawings per view, what's built and what's built plus what's planned, so neither has room left for the other.
  const variants = [{ planned: false, spec: overviewSpec(c, { planned: false }) }, { planned: true, spec: overviewSpec(c, { planned: true }) }];
  const frames: string[] = [];
  for (const v of views) for (const { planned, spec } of variants) {
    const L = layoutSystemMap(spec, v);
    const svg = drawSystemMap(spec, L, undefined, { mode: 'inline', idPrefix: `structure-${v}${planned ? '-planned' : ''}`, interactive: true, partLinks: true });
    frames.push(`<section class="frame" data-sv="running" data-view="${esc(v)}" data-planned="${planned ? 1 : 0}">
<h2 class="frame-title">The running parts · ${esc(viewLabel(c.m, v))}${planned ? ' · with what\'s planned' : ''}</h2>
<div class="${gridClass(L.width)}">${figure(svg, widths, L.width)}
<aside class="panel" aria-live="polite"><div class="picked" hidden></div>
<h3>What runs where, and what talks to what.</h3>
<p>${esc(c.m.views!.find((x) => x.id === v)?.note ?? '')}</p>
<ul class="legend"><li><b>›</b> opens the part's own page: what's inside it</li><li>Click any other part for what it is</li><li><b>Hatched</b>, dotted, <b>PHASE n · PLANNED</b>: not built yet (turn on “planned”)</li><li>A shaded box, <b>not ours</b>: another company's part (a dashed outline around parts is a machine or an account)</li></ul>
</aside></div></section>`);
  }
  const code = codeSpec(c);
  const LC = layoutSystemMap(code, '');
  frames.push(`<section class="frame" data-sv="code">
<h2 class="frame-title">The code · its packages</h2>
<div class="frame-grid">${figure(drawSystemMap(code, LC, undefined, { mode: 'inline', idPrefix: 'structure-code', interactive: true }), widths, LC.width)}
<aside class="panel" aria-live="polite"><div class="picked" hidden></div>
<h3>${esc(c.m.code!.question)}</h3>
<p>Each arrow is read from the imports: the package at its tail uses the one at its head. Click a package for what's in it and which running parts its code is in.</p>
</aside></div></section>`);

  // Cards: the parts without a page of their own, per view; the packages.
  const cards: string[] = [];
  for (const v of views) for (const p of c.m.parts.filter((x) => inView(x, v))) cards.push(partCard(c, p, v));
  for (const pk of c.m.code!.packages) {
    const files = c.facts.sources.filter((f) => f.startsWith(`${pk.id}/src/`));
    const inParts = views.flatMap((v) => c.m.parts.filter((p) => inView(p, v) && partFiles(c.m, c.facts, p.id, v).some((f) => f.startsWith(`${pk.id}/`)))
      .map((p) => `${partIn(p, v).label} (${viewLabel(c.m, v)})`));
    cards.push(`<article class="card" data-box="${esc(pk.id)}">
<h3>${esc(pk.label)}</h3>${pk.note ? `<p class="note">${esc(pk.note)}</p>` : ''}
${pk.text ? `<p>${rich(pk.text)}</p>` : ''}
<p><span class="kicker">Code</span> ${codeLink(c, `${pk.id}/src/`)} · ${files.length} files</p>
<p><span class="kicker">Runs in</span> ${[...new Set(inParts)].map(esc).join(', ') || 'no running part'}</p>
</article>`);
  }

  const controls = `<nav class="controls" aria-label="What the map shows">
<div class="seg" role="group" aria-label="View"><button type="button" data-sv="running">Running parts</button><button type="button" data-sv="code">Code</button></div>
<div class="seg" role="group" aria-label="Where it runs">${views.map((v) => `<button type="button" data-view="${esc(v)}" data-for-sv="running">${esc(viewLabel(c.m, v))}</button>`).join('')}</div>
<button type="button" class="switch" data-planned data-for-sv="running" aria-label="Show what's planned">+ planned</button>
</nav>`;
  const body = `${nav('context')}
<header class="top"><span class="eyebrow">System map · context</span><h1>${esc(c.m.title)}</h1>
<p class="question">Who uses it, and where does each copy run?</p></header>
${controls}
<main class="frames">${frames.join('\n')}</main>
<section class="cards boxes"><h2>The parts and the packages</h2><div class="card-grid">${cards.join('\n')}</div></section>`;
  return shell(`${c.m.title}: context`, body, { css: scrollHintCss(widths), data: { views, svs: ['running', 'code'], svOf: Object.fromEntries(c.m.code!.packages.map((p) => [p.id, 'code'])) }, script: c.script });
}

async function partPage(c: Ctx, page: Page): Promise<string> {
  const views = pageViews(c.m, page);
  const widths: number[] = [];
  const title = pageTitle(c.m, page);
  const spec = insideSpec(c, page);
  const locator = overviewSpec(c, { planned: false, focus: page.parts });
  const lead = c.m.parts.find((p) => p.id === page.parts[0])!;
  const frames = views.map((v) => {
    const L = layoutSystemMap(spec, views.length > 1 ? v : '');
    const svg = drawSystemMap(spec, L, undefined, { mode: 'inline', idPrefix: `${page.id}-${v}`, interactive: true, partLinks: true });
    const foundations = page.boxes.filter((b) => b.foundation && inView(b, v));
    return `<section class="frame" data-view="${esc(v)}">
<h2 class="frame-title">Inside ${esc(title)}${views.length > 1 ? ` · ${esc(viewLabel(c.m, v))}` : ''}</h2>
<div class="${gridClass(L.width)}">${figure(svg, widths, L.width)}
<aside class="panel" aria-live="polite"><div class="picked" hidden></div>
<h3>Click a box for what it is, its code and its decisions.</h3>
<ul class="legend">
<li><b>→</b> ${page.reads === 'aws' ? 'read from the stack: the box at its tail names or may use the one at its head (its words: what it may do)' : 'read from the imports: the box at its tail uses the one at its head'}</li>
${foundations.length ? `<li><b>No lines:</b> ${foundations.map((b) => esc(b.label)).join(' and ')}, used by nearly every box (each says by which)</li>` : ''}
<li><b>Outside the boundary:</b> the parts around it; <b>›</b> opens their page</li>
${page.boxes.some((b) => b.status === 'proposed') ? '<li><b>Hatched</b>, dotted, <b>PHASE n · PLANNED</b>: not built yet (turn on “planned”)</li>' : ''}
</ul>
</aside></div></section>`;
  });

  // The boxes' cards, per view where they differ (foundation users, lines).
  const cards: string[] = [];
  for (const v of views) for (const b of page.boxes.filter((x) => inView(x, v))) {
    const lines = readLines(page, v, c.facts);
    const label = (id: string) => page.boxes.find((x) => x.id === id)?.label ?? id;
    const uses = lines.filter((l) => l.from === b.id || (l.both && l.to === b.id)).map((l) => label(l.from === b.id ? l.to : l.from));
    const usedBy = lines.filter((l) => l.to === b.id || (l.both && l.from === b.id)).map((l) => label(l.to === b.id ? l.from : l.to));
    const users = b.foundation ? foundationUsers(page, b, v, c.facts).map(label) : [];
    const resources = b.resources?.length ? c.facts.aws.resources.filter((r) => b.resources!.some((g) => matchesGlob(r.id, g))) : [];
    const about = decisionsAbout(c.log, b.id);
    cards.push(`<article class="card${b.status === 'proposed' ? ' planned-only' : ''}" data-box="${esc(b.id)}" data-view="${esc(v)}" id="box-${esc(v)}-${esc(b.id)}">
<h3>${esc(b.label)}${b.status === 'proposed' ? ' <span class="tag">planned</span>' : ''}${b.foundation ? ' <span class="tag">foundation</span>' : ''}</h3>
${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}
${b.text ? `<p>${rich(b.text)}</p>` : ''}
${users.length ? `<p><span class="kicker">Used by</span> ${users.map(esc).join(', ')}</p>` : ''}
${uses.length ? `<p><span class="kicker">Uses</span> ${uses.map(esc).join(', ')}</p>` : ''}
${usedBy.length ? `<p><span class="kicker">Used by</span> ${usedBy.map(esc).join(', ')}</p>` : ''}
${b.code?.length ? `<p><span class="kicker">Code</span> ${b.code.map((g) => codeLink(c, g)).join(' ')}</p>` : ''}
${b.tests?.length ? `<p><span class="kicker">Tests</span> ${b.tests.map((g) => codeLink(c, g)).join(' ')}</p>` : ''}
${resources.length ? `<details><summary><span class="kicker">In AWS</span> ${resources.length} resource${resources.length === 1 ? '' : 's'}</summary><ul>${resources.map((r) => `<li><code>${esc(r.id)}</code> ${esc(r.type)}</li>`).join('')}</ul></details>` : ''}
${b.needs?.length ? `<p><span class="kicker">Would be built by</span> ${b.needs.map((r) => `<code>${esc(r)}</code>`).join(' ')}</p>` : ''}
${about.flatMap(({ decision, aspects }) => aspects.map((a) => choiceList(a, decision.id))).join('\n')}
${about.length ? `<div class="decisions"><span class="kicker">Decisions</span>${about.map(({ decision, aspects }) => decisionCard(c, decision, { aspects: aspects.length ? [] : undefined, chips: false, id: false })).join('\n')}</div>` : ''}
</article>`);
  }
  // Decisions about the part or any of its boxes; use-case steps through the part.
  const ids = new Set([...page.parts, ...page.boxes.map((b) => b.id)]);
  const decisions = c.log.decisions.filter((d) => (d.parts ?? []).some((p) => ids.has(p)) || (d.aspects ?? []).some((a) => a.parts.some((p) => ids.has(p))));
  const steps = c.m.flows.flatMap((f, fi) => f.steps.map((s, si) => ({ f, fi, s, si })))
    .filter(({ s }) => views.some((v) => inView(s, v)) && (page.parts.includes(s.from) || page.parts.includes(s.to ?? '')));
  const own = [...new Set(views.flatMap((v) => page.parts.flatMap((id) => partIn(c.m.parts.find((p) => p.id === id)!, v).code ?? [])))];
  const tests = [...new Set(views.flatMap((v) => page.parts.flatMap((id) => partIn(c.m.parts.find((p) => p.id === id)!, v).tests ?? [])))];

  const locators = views.map((v) => {
    const L = layoutSystemMap(locator, v);
    return `<figure class="locator"><figcaption>${esc(viewLabel(c.m, v))}</figcaption>${figure(drawSystemMap(locator, L, undefined, { mode: 'inline', idPrefix: `${page.id}-where-${v}`, interactive: true, partLinks: true }), widths, L.width)}</figure>`;
  }).join('');
  const controls = (views.length > 1 || page.boxes.some((b) => b.status === 'proposed')) ? `<nav class="controls" aria-label="What the map shows">
${views.length > 1 ? `<div class="seg" role="group" aria-label="Where it runs">${views.map((v) => `<button type="button" data-view="${esc(v)}">${esc(viewLabel(c.m, v))}</button>`).join('')}</div>` : ''}
${page.boxes.some((b) => b.status === 'proposed') ? '<button type="button" class="switch" data-planned aria-label="Show what\'s planned">+ planned</button>' : ''}
</nav>` : '';
  const body = `${nav('part', [{ label: 'Architecture', href: 'index.html' }, { label: title }])}
<header class="top"><span class="eyebrow">System map · a part</span><h1>${esc(title)}</h1>
<p class="question">${esc(page.question)}</p>
${lead.text ? `<p class="lede">${rich(partIn(lead, views[0]!).text ?? lead.text)}</p>` : ''}</header>
${controls}
<main class="frames">${frames.join('\n')}</main>
<section class="cards boxes"><h2>The boxes</h2><div class="card-grid">${cards.join('\n')}</div></section>
<section id="decisions"><h2>Decisions about ${esc(title)}</h2>
${decisions.length ? `<div class="decisions">${decisions.map((d) => decisionCard(c, d)).join('\n')}</div>` : '<p>None recorded.</p>'}</section>
<section><h2>Use-case steps through ${esc(title)}</h2>
<ol class="steps-through">${steps.map(({ f, fi, s, si }) => `<li><span class="num">${fi + 1}</span><span><a href="use-cases.html#step=${fi + 1}"><strong>${esc(f.label)}</strong></a>, step ${si + 1}: ${rich(s.label)}</span></li>`).join('')}</ol></section>
<section class="where-it-sits"><h2>Where it sits</h2><p class="lede">The whole system, with ${esc(title)} in green. Click a part with › to go to its page.</p><div class="locators">${locators}</div></section>
<section><h2>Code and tests</h2>
<p><span class="kicker">Code</span> ${own.map((g) => codeLink(c, g)).join(' ')}</p>
${tests.length ? `<p><span class="kicker">Tests</span> ${tests.map((g) => codeLink(c, g)).join(' ')}</p>` : ''}
${page.shared?.length ? `<p><span class="kicker">In no one box</span></p><ul>${page.shared.map((s) => `<li>${codeLink(c, s.glob)}: ${esc(s.why)}</li>`).join('')}</ul>` : ''}
</section>`;
  return shell(`${title}: ${c.m.title}`, body, { css: scrollHintCss(widths), data: { views, svs: [''] }, script: c.script });
}

/** A requirement as a link to its line in qa/traceability.yaml, with its sentence on hover. */
const requirementLink = (c: Ctx, id: string) => {
  const q = c.facts.requirements.get(id);
  return q ? `<a href="${esc(c.codeBase)}qa/traceability.yaml#L${q.line}" title="${esc(q.text)}"><code>${esc(id)}</code></a>` : `<code>${esc(id)}</code>`;
};

/** An architecture box's card: what it is; a contract's sides and the suites that prove them; what a box implements. */
function archCard(c: Ctx, b: ArchBox, shown: { id: string; label: string; note?: string } = b): string {
  const a = c.m.architecture!;
  const boxes = a.boxes;
  const phase = b.status === 'proposed' ? phaseOf(b, c.facts) : undefined;
  const part = b.part ? c.m.parts.find((p) => p.id === b.part) : undefined;
  const views = b.view ? [b.view] : (c.m.views ?? []).map((v) => v.id);
  const pg = part ? views.map((v) => pageOf(c.m, part.id, v)).find(Boolean) : undefined;
  const sideOf = (x: ArchBox) => a.zones.find((z) => z.id === x.zone)?.label ?? 'everywhere';
  const plugged = boxes.filter((x) => x.plugs?.into === b.id);
  const into = b.plugs ? boxes.find((x) => x.id === b.plugs!.into) : undefined;
  const tests = (globs: string[]) => globs.map((g) => codeLink(c, g)).join(' ');
  const about = part ? decisionsAbout(c.log, part.id) : [];
  return `<article class="card" data-box="${esc(shown.id)}">
<h3>${esc(shown.label)}${b.contract ? ' <span class="tag">contract</span>' : ''}${b.status === 'proposed' ? ` <span class="tag">${phase ? `phase ${esc(phase)} · ` : ''}planned</span>` : ''}${b.external ? ' <span class="tag">not ours</span>' : ''}</h3>
${shown.note ? `<p class="note">${esc(shown.note)}</p>` : ''}
${b.text ? `<p>${rich(b.text)}</p>` : ''}
${b.contract ? `<p><span class="kicker">Declared</span> <code>${esc(b.contract.name)}</code> in ${codeLink(c, b.contract.file)}</p>
<ul class="plugged">${plugged.map((x) => `<li><span class="kicker">${esc(sideOf(x))}</span> ${esc(x.label)}${x.note ? ` <span class="note">${esc(x.note)}</span>` : ''}${x.status === 'proposed' ? ' <span class="tag">planned</span>' : ''}</li>`).join('')}</ul>
${b.contract.shared ? `<p><span class="kicker">Implemented once, for every side</span> ${codeLink(c, b.contract.shared)}</p>` : b.contract.suites?.length ? `<p><span class="kicker">Proved on both sides by</span> ${b.contract.suites.map((s) => `<code>${esc(s)}</code>`).join(', ')}: ${tests([...a.proof.local, ...a.proof.aws])}</p>` : `<p><span class="kicker">Not proven yet</span> no shared suite runs on both sides' adapters, so swapping a side isn't shown to work.</p>`}` : ''}
${b.tests?.length ? `<p><span class="kicker">Tests</span> ${b.tests.map((g) => codeLink(c, g)).join(' ')}</p>` : ''}
${into ? `<p><span class="kicker">Plugs into</span> ${esc(into.label)}${b.status === 'proposed' ? ' (once built)' : `, as ${b.plugs!.implements.map((n) => `<code>${esc(n)}</code>`).join(', ')}`}</p>` : ''}
${b.code?.length ? `<p><span class="kicker">Code</span> ${b.code.map((g) => codeLink(c, g)).join(' ')}</p>` : ''}
${b.needs?.length ? `<p><span class="kicker">Would be built by</span> ${b.needs.map((r) => requirementLink(c, r)).join(' ')}</p>` : ''}
${pg ? `<p><a href="${pg.id}.html"><strong>Inside ${esc(pageTitle(c.m, pg))} ›</strong></a></p>` : ''}
${about.length ? `<p><span class="kicker">Decisions</span> ${about.map(({ decision: d }) => `<a href="decisions.html#decision-${esc(d.id)}">${esc(d.title ? d.title.replace(/:$/, '') : d.id)}</a>`).join(' · ')}</p>` : ''}
</article>`;
}

/** The key beside a drawing: a mark and a few words each, never a paragraph (visual first). */
const key = (items: [string, string][]) => `<ul class="legend key">${items.map(([mark, words]) => `<li><b>${mark}</b> ${words}</li>`).join('')}</ul>`;
const PLANNED_KEY: [string, string] = ['Hatched', 'planned, with its phase'];
const NOT_OURS_KEY: [string, string] = ['Shaded', 'not ours'];

/** A landing box's card: one detailed box's card under the landing's name, or what a box standing for several holds. */
function overviewCard(c: Ctx, o: OverviewBox): string {
  const a = c.m.architecture!;
  const of = o.of.map((id) => a.boxes.find((b) => b.id === id)!);
  if (of.length === 1) return archCard(c, of[0]!, { id: o.id, label: o.label, note: o.note });
  const zoom = a.zooms.find((z) => z.id === o.zoom);
  return `<article class="card" data-box="${esc(o.id)}">
<h3>${esc(o.label)}${o.kind === 'port' ? ' <span class="tag">contracts</span>' : ''}</h3>
${o.note ? `<p class="note">${esc(o.note)}</p>` : ''}
${o.text ? `<p>${rich(o.text)}</p>` : ''}
<ul class="plugged">${of.map((b) => `<li>${esc(b.label)}${b.note ? ` <span class="note">${esc(unprovenContract(b) ? UNPROVEN : b.note)}</span>` : ''}</li>`).join('')}</ul>
${zoom ? `<p><a href="${esc(zoom.id)}.html"><strong>Zoom in: ${esc(zoom.title)} ›</strong></a></p>` : ''}
</article>`;
}

/** A drawing in a frame with its key and the card of a picked box beside it. */
function drawingFrame(spec: ReturnType<typeof parseSystemMap>['spec'], idPrefix: string, title: string, items: [string, string][], widths: number[]): string {
  const L = layoutSystemMap(spec, '');
  const svg = drawSystemMap(spec, L, undefined, { mode: 'inline', idPrefix, interactive: true, partLinks: true });
  return `<main class="frames"><section class="frame">
<h2 class="frame-title">${esc(title)}</h2>
<div class="${gridClass(L.width)}">${figure(svg, widths, L.width)}
<aside class="panel" aria-live="polite"><div class="picked" hidden></div>
<p class="hint">Click a box for what it is.</p>
${key(items)}
</aside></div></section></main>`;
}

/** The landing: the architecture at a high level, a few boxes; the ports' detail is a zoom away (architecture.ts). */
function architecturePage(c: Ctx): string {
  const a = c.m.architecture!;
  const widths: number[] = [];
  const spec = parseSystemMap(landingSpec(c.m, c.facts)).spec;
  const body = `${nav('architecture')}
<header class="top"><span class="eyebrow">System map · architecture</span><h1>${esc(c.m.title)}</h1>
<p class="question">${esc(a.question)}</p></header>
${drawingFrame(spec, 'architecture', 'The architecture · on one machine and in AWS, with what\'s planned', [
    ['⊐ ⊏', 'swappable beneath (a contract)'], PLANNED_KEY, NOT_OURS_KEY, ['›', 'zoom in'],
  ], widths)}
<section class="cards boxes"><h2>The boxes</h2><div class="card-grid">${a.overview.boxes.map((o) => overviewCard(c, o)).join('\n')}</div></section>`;
  // What's planned is always shown here (hatched, with its phase): the landing shows today and what's next together.
  return shell(`${c.m.title}: architecture`, body, { css: scrollHintCss(widths), data: { views: [''], svs: [''], planned: true, center: true }, script: c.script });
}

/** One level down from the landing: the detailed boxes some landing boxes stand for, each with its card. */
function zoomPage(c: Ctx, z: Zoom): string {
  const a = c.m.architecture!;
  const widths: number[] = [];
  const ids = zoomBoxes(a, z);
  const spec = parseSystemMap(architectureSpec(c.m, c.facts, ids)).spec;
  const drawn = a.boxes.filter((b) => ids.includes(b.id));
  const body = `${nav('part', [{ label: 'Architecture', href: 'index.html' }, { label: z.title }])}
<header class="top"><span class="eyebrow">System map · zoomed in</span><h1>${esc(z.title)}</h1>
<p class="question">${esc(z.question)}</p></header>
${drawingFrame(spec, `zoom-${z.id}`, `${z.title} · on one machine and in AWS`, [
    ['⊐ ⊏', 'a contract: what the rest is written against'], ['—', 'plugs in: implements it, checked in the code'],
    [UNPROVEN, 'no shared suite proves a swap'], PLANNED_KEY, ['›', 'its own page'],
  ], widths)}
<section class="cards boxes"><h2>The boxes</h2><div class="card-grid">${drawn.map((b) => archCard(c, b)).join('\n')}</div></section>`;
  return shell(`${z.title}: ${c.m.title}`, body, { css: scrollHintCss(widths), data: { views: [''], svs: [''], planned: true, center: true }, script: c.script });
}

function decisionsPage(c: Ctx): string {
  const w = where(c);
  const named = new Set(c.log.decisions.flatMap((d) => [...(d.parts ?? []), ...(d.aspects ?? []).flatMap((a) => a.parts)]));
  // Filters: the parts and pages decisions are about, each linking to the cards about it.
  const levels = [
    ...c.m.parts.filter((p) => named.has(p.id)).map((p) => ({ id: p.id, label: w.get(p.id)!.label })),
    ...(c.m.pages ?? []).flatMap((pg) => pg.boxes.filter((b) => named.has(b.id)).map((b) => ({ id: b.id, label: w.get(b.id)!.label }))),
  ];
  const groups = c.log.groups.map((g) => {
    const ds = c.log.decisions.filter((d) => d.group === g.id);
    return `<section class="group"><h2>${esc(g.heading)}</h2>${g.note ? `<p class="lede">${rich(g.note)}</p>` : ''}<div class="decisions">${ds.map((d) => decisionCard(c, d)).join('\n')}</div></section>`;
  }).join('\n');
  const open = c.log.open.length ? `<section><h2>Open</h2><ul class="open-questions">${c.log.open.map((q) => `<li><span class="did">${esc(q.id)}</span> <strong>${rich(q.question)}</strong> <span class="meta">${esc(q.owner)} · ${esc(q.due)}</span></li>`).join('')}</ul></section>` : '';
  const total = c.log.decisions.length, notYet = c.log.decisions.filter((d) => /^Not built/.test(d.built)).length;
  const body = `${nav('decisions')}
<header class="top"><span class="eyebrow">System map · decisions</span><h1>${esc(c.m.title)}</h1>
<p class="question">What was decided, over what, and about which part?</p>
<p class="lede">${total} decisions, ${notYet} not built yet. Each names the parts it's about: a part's page shows its decisions beside its boxes. Where several options were weighed, the decision opens to show them side by side. The same log, as a table: <a href="../decisions.md">docs/decisions.md</a>, built from <a href="../decisions.yaml">docs/decisions.yaml</a>.</p></header>
<nav class="filters" aria-label="Decisions about a part"><span class="kicker">Jump to a part</span> ${levels.map((l) => `<a class="chip" href="${esc(w.get(l.id)!.href)}">${esc(l.label)}</a>`).join(' ')}</nav>
${groups}
${open}`;
  return shell(`${c.m.title}: decisions`, body, { script: c.script, extra: OPEN_TARGET });
}

/** A link to one decision (#decision-B13) opens it. */
const OPEN_TARGET = `(() => {
  const open = () => { const d = location.hash.startsWith('#decision-') && document.getElementById(location.hash.slice(1)); if (d) d.open = true; };
  window.addEventListener('hashchange', open); open();
})();`;

/** Every page of the map, by its path under the repo. */
export async function buildSite(m: MapSource, facts: Facts, log: DecisionLog, codeBase: string, opts: SiteOptions = {}): Promise<{ files: Map<string, string>; warnings: string[] }> {
  const c: Ctx = { m, facts, log, codeBase, script: !opts.static };
  const files = new Map<string, string>();
  const warnings: string[] = [];
  const header = nav('use-cases');
  const uc = await buildSystemMapFrom(useCaseSpec(c), { static: opts.static, header, css: SITE_NAV_CSS });
  warnings.push(...uc.warnings);
  if (m.architecture) {
    warnings.push(...parseSystemMap(landingSpec(m, facts)).warnings.map((w) => `architecture: ${w}`));
    files.set(`${MAP_DIR}/index.html`, architecturePage(c));
    for (const z of m.architecture.zooms) {
      warnings.push(...parseSystemMap(architectureSpec(m, facts, zoomBoxes(m.architecture, z))).warnings.map((w) => `${z.id}: ${w}`));
      files.set(`${MAP_DIR}/${z.id}.html`, zoomPage(c, z));
    }
  }
  files.set(`${MAP_DIR}/use-cases.html`, uc.html + '\n');
  files.set(`${MAP_DIR}/context.html`, await contextPage(c));
  files.set(`${MAP_DIR}/decisions.html`, decisionsPage(c));
  for (const page of m.pages ?? []) files.set(`${MAP_DIR}/${page.id}.html`, await partPage(c, page));
  return { files, warnings };
}

/** The navigation's styles, for the use-case page (the renderer's own page, which has the rest). */
const SITE_NAV_CSS = `
nav.site { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; padding-top: 14px; }
nav.site .brand { font: 600 12px ${fonts.mono}; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); text-decoration: none; }
nav.site .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
nav.site .tabs a { font: 600 14px ${fonts.sans}; color: var(--ink); text-decoration: none; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); }
nav.site .tabs a[aria-current="page"] { background: var(--ink); color: var(--card); border-color: var(--ink); }
nav.site a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
header.top { padding-block: 10px 12px; }
.part-detail a.opens { font-weight: 700; }
`;
