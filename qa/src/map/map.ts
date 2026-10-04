// The system map's source (docs/map/map.yaml): what's written by hand, how it is checked against the code (facts.ts),
// and how it becomes the spec the renderer draws. Each problem names its rule, so a test can plant one of each.
import { matchesGlob, posix } from 'node:path';
import { architectureText, checkArchitecture, phaseOf, type Architecture } from './architecture.ts';
import { PACKAGES, type Facts } from './facts.ts';
import { checkCodeView, checkPages, pageOf, type CodeView, type Page } from './pages.ts';

type Link = { label: string; href: string };
type Override = { label?: string; note?: string; at?: [number, number]; zone?: string; external?: boolean; text?: string; code?: string[]; tests?: string[] };
export type Part = {
  id: string; label: string; note?: string; kind?: string; external?: boolean; status?: 'existing' | 'proposed';
  at: [number, number]; zone?: string; only?: string[]; views?: Record<string, Override>;
  text?: string; code?: string[]; tests?: string[]; links?: Link[];
  /** A planned part: the requirements that would build it. */
  needs?: string[];
};
export type Step = {
  from: string; to?: string; label: string; emphasis?: 'alert'; status?: 'existing' | 'proposed'; only?: string[];
  tools?: string[]; commands?: string[];
  /** The API's operations the step uses: one list, or one per view where they differ (on one machine the client calls
   *  the catalog in its own process; in AWS over HTTP). */
  operations?: string[] | Record<string, string[]>;
};
export type Flow = {
  id: string; label: string; who?: string; says?: string; status?: 'existing' | 'proposed';
  steps: Step[]; wait?: { title: string; text: string }; screens?: string[]; checks?: string[];
};
export type MapSource = {
  title: string; question: string; alertWord?: string; codeBase: string;
  views?: { id: string; label: string; note?: string }[]; zones?: unknown[];
  parts: Part[]; links?: { from: string; to: string; label?: string; status?: string; only?: string[] }[]; flows: Flow[];
  left_out?: { tools?: Record<string, string>; commands?: Record<string, string>; operations?: Record<string, string> };
  not_on_map?: { glob: string; why: string }[];
  /** A page per part: the boxes inside it (pages.ts). */
  pages?: Page[];
  /** The code's packages and what uses what between them. */
  code?: CodeView;
  /** The architecture: the contracts in the middle, what plugs into each on one machine and in AWS (architecture.ts). */
  architecture?: Architecture;
};

export type Rule =
  | 'glob-matches-nothing' | 'file-in-no-part' | 'planned-part-has-code' | 'unknown-tool' | 'unknown-command'
  | 'unknown-operation' | 'unknown-requirement' | 'tool-in-no-step' | 'command-in-no-step' | 'operation-in-no-step'
  | 'unknown-view' | 'left-out-without-why'
  | 'missing-screen' | 'banned-word' | 'unknown-flow' | 'unreadable-on-phone'
  // pages.ts: a page per part, and the Code view
  | 'unknown-part' | 'duplicate-id' | 'planned-needs-nothing' | 'file-in-no-box' | 'file-in-two-boxes' | 'box-file-outside-part'
  | 'resource-in-no-box' | 'resource-in-two-boxes' | 'line-not-in-code' | 'line-not-on-map' | 'too-dense' | 'package-not-shown'
  // decisions.ts: decisions as data
  | 'decision-unknown-part' | 'chosen-not-an-option' | 'unknown-decision'
  // architecture.ts: the contracts and what plugs into them
  | 'unknown-zone' | 'contract-not-in-code' | 'suite-not-run' | 'unknown-contract' | 'adapter-not-in-code' | 'unknown-field'
  | 'implements-other-contract' | 'contract-side-missing' | 'planned-phase-unclear';
export type Problem = { rule: Rule; message: string };

/** Words the map never uses (review V5.4, V5.6, V6.4; the owner's names): each with what to say instead. */
export const BANNED: [RegExp, string][] = [
  [/\bregistry\b/i, 'say "catalog" or "the API"'],
  [/\byour?\b/i, 'name who: Developer 1, Developer 2, the person'],
  [/\bAI assistant\b/i, 'say "assistant" or its name, Claude Code'],
  [/\bcore catalog\b/i, 'say "catalog"'],
  [/\blocal store\b/i, 'say "catalog" (on one machine)'],
];

/** A part's code and test patterns in every view, with where they're written. */
function patterns(p: Part): { where: string; kind: 'code' | 'tests'; glob: string }[] {
  const out: { where: string; kind: 'code' | 'tests'; glob: string }[] = [];
  const add = (where: string, o: { code?: string[]; tests?: string[] }) => {
    for (const glob of o.code ?? []) out.push({ where, kind: 'code', glob });
    for (const glob of o.tests ?? []) out.push({ where, kind: 'tests', glob });
  };
  add(`parts.${p.id}`, p);
  for (const [v, o] of Object.entries(p.views ?? {})) add(`parts.${p.id}.views.${v}`, o);
  return out;
}

/** Every way the map and the code disagree (empty when they agree). */
export function checkMap(m: MapSource, facts: Facts, exists: (path: string) => boolean): Problem[] {
  const problems: Problem[] = [];
  const add = (rule: Rule, message: string) => problems.push({ rule, message });

  // Files: every pattern finds something; every source file belongs to a part (or is off the map, with why); a part
  // marked planned has no code yet.
  const owned: string[] = [];
  for (const p of m.parts) for (const x of patterns(p)) {
    const found = facts.matches(x.glob);
    if (!found.length) add('glob-matches-nothing', `${x.where}.${x.kind}: "${x.glob}" matches no file`);
    if (x.kind === 'code') owned.push(x.glob);
    if (x.kind === 'code' && p.status === 'proposed' && found.length)
      add('planned-part-has-code', `${x.where}: "${p.label}" is planned, but "${x.glob}" has code (${found[0]}): it's built, so drop status: proposed`);
  }
  // A planned part names the requirements that would build it.
  for (const p of m.parts) {
    if (p.status === 'proposed' && !p.needs?.length) add('planned-needs-nothing', `parts.${p.id}: a planned part names the requirements that would build it (needs:)`);
    for (const r of p.needs ?? []) if (!facts.requirements.has(r)) add('unknown-requirement', `parts.${p.id}.needs: no requirement "${r}" in qa/traceability.yaml`);
  }
  for (const o of m.not_on_map ?? []) {
    if (!o.why?.trim()) add('left-out-without-why', `not_on_map: "${o.glob}" says no why`);
    if (!facts.matches(o.glob).length) add('glob-matches-nothing', `not_on_map: "${o.glob}" matches no file`);
    owned.push(o.glob);
  }
  for (const f of facts.sources) if (!owned.some((g) => matchesGlob(f, g)))
    add('file-in-no-part', `${f} belongs to no part: add it to a part's code, or to not_on_map with why`);

  // Steps: every tool, command and operation a step names exists; every requirement a flow names exists.
  const used = { tools: new Set<string>(), commands: new Set<string>(), operations: new Set<string>() };
  const views = new Set((m.views ?? []).map((v) => v.id));
  for (const f of m.flows) {
    f.steps.forEach((s, i) => {
      const at = `flows.${f.id}.steps.${i + 1}`;
      for (const t of s.tools ?? []) { used.tools.add(t); if (!facts.tools.has(t)) add('unknown-tool', `${at}: no tool "${t}" is served`); }
      for (const c of s.commands ?? []) { used.commands.add(c); if (!facts.commands.has(c)) add('unknown-command', `${at}: no command "skills-catalog ${c}"`); }
      const ops = Array.isArray(s.operations) ? { '': s.operations } : s.operations ?? {};
      for (const [view, list] of Object.entries(ops)) {
        if (view && !views.has(view)) add('unknown-view', `${at}.operations: no view "${view}"`);
        for (const o of list) { used.operations.add(o); if (!facts.operations.has(o)) add('unknown-operation', `${at}: no operation "${o}" in core/src/api.ts`); }
      }
    });
    for (const c of f.checks ?? []) if (!facts.requirements.has(c)) add('unknown-requirement', `flows.${f.id}.checks: no requirement "${c}" in qa/traceability.yaml`);
    for (const s of f.screens ?? []) if (!exists(s)) add('missing-screen', `flows.${f.id}.screens: ${s} doesn't exist`);
  }

  // Everything served is on the map, or left out with why; nothing left out is unknown.
  const left = { tools: m.left_out?.tools ?? {}, commands: m.left_out?.commands ?? {}, operations: m.left_out?.operations ?? {} };
  for (const t of facts.tools) if (!used.tools.has(t) && !Object.hasOwn(left.tools, t))
    add('tool-in-no-step', `the tool ${t} is in no step: name it in a step's tools, or under left_out.tools with why`);
  for (const c of facts.commands) if (!used.commands.has(c) && !Object.hasOwn(left.commands, c))
    add('command-in-no-step', `skills-catalog ${c} is in no step: name it in a step's commands, or under left_out.commands with why`);
  // An operation is on the map when a step names it, or names (or leaves out, with why) the tool that runs it.
  for (const t of [...used.tools, ...Object.keys(left.tools)]) { const op = facts.toolOps.get(t); if (op) used.operations.add(op); }
  for (const o of facts.operations) if (!used.operations.has(o) && !Object.hasOwn(left.operations, o))
    add('operation-in-no-step', `the operation ${o} is in no step: name it in a step's operations, or under left_out.operations with why`);
  for (const [kind, names] of Object.entries(left) as ['tools' | 'commands' | 'operations', Record<string, string>][]) for (const [name, why] of Object.entries(names)) {
    if (!String(why ?? '').trim()) add('left-out-without-why', `left_out.${kind}.${name} says no why`);
    if (kind === 'tools' && !facts.tools.has(name)) add('unknown-tool', `left_out.tools: no tool "${name}" is served`);
    if (kind === 'commands' && !facts.commands.has(name)) add('unknown-command', `left_out.commands: no command "skills-catalog ${name}"`);
    if (kind === 'operations' && !facts.operations.has(name)) add('unknown-operation', `left_out.operations: no operation "${name}" in core/src/api.ts`);
  }

  // The pages inside the parts, and the Code view.
  problems.push(...checkPages(m, facts), ...checkCodeView(m.code, PACKAGES), ...checkArchitecture(m, facts));

  // Words: what a reader sees never uses the banned ones.
  for (const [where, text] of shownText(m)) for (const [re, instead] of BANNED) {
    const hit = text.match(re);
    if (hit) add('banned-word', `${where}: "${hit[0]}" (${instead})`);
  }
  return problems;
}

/** Every piece of text a reader sees, with where it's written. */
function shownText(m: MapSource): [string, string][] {
  const out: [string, string][] = [['title', m.title], ['question', m.question]];
  for (const v of m.views ?? []) out.push([`views.${v.id}`, `${v.label} ${v.note ?? ''}`]);
  for (const z of (m.zones ?? []) as { id: string; label: string }[]) out.push([`zones.${z.id}`, z.label]);
  for (const p of m.parts) {
    out.push([`parts.${p.id}`, [p.label, p.note, p.text].filter(Boolean).join(' ')]);
    for (const [v, o] of Object.entries(p.views ?? {})) out.push([`parts.${p.id}.views.${v}`, [o.label, o.note, o.text].filter(Boolean).join(' ')]);
  }
  for (const l of m.links ?? []) if (l.label) out.push([`links.${l.from}-${l.to}`, l.label]);
  for (const f of m.flows) {
    out.push([`flows.${f.id}`, [f.label, f.who, f.says, f.wait?.title, f.wait?.text].filter(Boolean).join(' ')]);
    f.steps.forEach((s, i) => out.push([`flows.${f.id}.steps.${i + 1}`, s.label]));
  }
  for (const pg of m.pages ?? []) {
    out.push([`pages.${pg.id}`, [pg.title, pg.question, pg.zone, ...(pg.context ?? []).map((c) => c.label)].filter(Boolean).join(' ')]);
    for (const b of pg.boxes) out.push([`pages.${pg.id}.boxes.${b.id}`, [b.label, b.note, b.text].filter(Boolean).join(' ')]);
    for (const l of pg.lines ?? []) if (l.label) out.push([`pages.${pg.id}.lines`, l.label]);
    for (const s of pg.shared ?? []) out.push([`pages.${pg.id}.shared`, s.why]);
  }
  if (m.code) {
    out.push(['code', m.code.question]);
    for (const p of m.code.packages) out.push([`code.packages.${p.id}`, [p.label, p.note, p.text].filter(Boolean).join(' ')]);
  }
  out.push(...architectureText(m.architecture));
  return out;
}

/** The spec the renderer draws: the hand-written map, with each step's checks and screens filled in from the repo. */
export function toSpec(m: MapSource, facts: Facts, pageDir: string): Record<string, unknown> {
  const detail = (p: { text?: string; code?: string[]; tests?: string[] }, links?: Link[]) =>
    p.text ? { text: p.text, code: p.code ?? [], tests: p.tests ?? [], links: links ?? [] } : undefined;
  // A part with a page of its own in a view (pages.ts) links to it there: one page per part, or per view.
  const viewIds = (m.views ?? []).map((v) => v.id);
  const hrefs = (id: string) => Object.fromEntries(viewIds.map((v) => [v, pageOf(m, id, v)]).filter(([, pg]) => pg).map(([v, pg]) => [v, `${(pg as Page).id}.html`]));
  const parts = m.parts.map(({ text, code, tests, links, views, needs, ...p }) => {
    const pages = hrefs(p.id);
    // A planned part says its phase: the phase of the requirements that would build it.
    const phase = p.status === 'proposed' ? phaseOf({ needs }, facts) : undefined;
    if (phase) Object.assign(p, { phase });
    const vs: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(views ?? {}).map(([v, o]) => {
      const { text: t, code: c, tests: ts, ...rest } = o;
      const own = t !== undefined || c !== undefined || ts !== undefined;
      return [v, own ? { ...rest, detail: detail({ text: t ?? text, code: c ?? code, tests: ts ?? tests }, links) } : rest];
    }));
    for (const [v, href] of Object.entries(pages)) vs[v] = { ...(vs[v] ?? {}), href };
    return { ...p, detail: detail({ text, code, tests }, links), views: vs };
  });
  const flows = m.flows.map(({ screens, checks, steps, ...f }) => ({
    ...f,
    steps: steps.map(({ tools: _t, commands: _c, operations: _o, ...s }) => s),
    screens: (screens ?? []).map((s) => {
      const rel = posix.relative(pageDir, s);
      return { label: posix.basename(s), href: rel, thumb: rel };
    }),
    checks: (checks ?? []).map((id) => {
      const r = facts.requirements.get(id);
      return r ? { id, text: r.text, href: `${m.codeBase}qa/traceability.yaml#L${r.line}` } : id;
    }),
  }));
  const { left_out: _l, not_on_map: _n, pages: _p, code: _c, architecture: _a, ...rest } = m;
  return { kind: 'system-map', ...rest, parts, flows };
}
