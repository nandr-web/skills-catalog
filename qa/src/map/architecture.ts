// The architecture (docs/map/index.html): the system as one picture, built around its contracts. In the middle, the
// contracts the rest is written against (the Catalog every face calls; the ports its rules call); on each side, what
// plugs into each contract on one machine and in AWS; on top, who uses it; planned parts hatched, with their phase.
// Written by hand: the boxes, their names and places. Checked against the code (checkArchitecture): each contract is
// declared where it says, each box that plugs in implements what it says, each shared suite that proves a contract
// runs on both sides, and every hand line is a link one level up or an import between the two boxes' files.
import { matchesGlob } from 'node:path';
import type { Facts } from './facts.ts';
import type { MapSource, Problem, Rule } from './map.ts';
import { pageOf } from './pages.ts';

type Cell = [number, number];
export type ArchBox = {
  id: string; label: string; note?: string; kind?: 'service' | 'store' | 'queue' | 'actor' | 'port'; external?: boolean;
  status?: 'existing' | 'proposed'; at: Cell; zone?: string;
  /** The part one level up this box stands for: its page, card, decisions and links are the part's. */
  part?: string;
  /** Where the part has a page per view, the view whose page this box opens. */
  view?: string;
  /** A contract: the interface (or class) the rest is written against, and the file that declares it. `shared`: a
   *  contract implemented once, the same on every side (the file that implements it), instead of an adapter per side. */
  contract?: { name: string; file: string; suites?: string[]; shared?: string };
  /** What plugs into a contract: which contract box, and the interfaces its code implements. */
  plugs?: { into: string; implements: string[] };
  /** A planned box: the requirements that would build it (its phase is theirs). */
  needs?: string[];
  text?: string; code?: string[]; tests?: string[];
};
export type ArchLine = { from: string; to: string; label?: string };
export type Architecture = {
  question: string;
  zones: { id: string; label: string; style?: 'boundary' | 'region' }[];
  /** The zones a contract's adapters must cover, one adapter each (on one machine, in AWS), with the code that is that
   *  side's own. A box in a side's zone holds only that side's code; an adapter in any other zone (the same everywhere)
   *  covers every side, and holds none of the sides' own code. */
  sides: { zone: string; code: string[] }[];
  boxes: ArchBox[];
  lines?: ArchLine[];
  /** The shared suites a contract names run on the local adapters (in `local`) and on the AWS ones (in `aws`). */
  proof: { text: string; local: string[]; aws: string[] };
};

/** A planned box's phase, from the requirements that would build it: "2", or "2–3" when they span phases. */
export function phaseOf(b: Pick<ArchBox, 'needs'>, facts: Facts): string | undefined {
  const ps = [...new Set((b.needs ?? []).map((r) => facts.requirements.get(r)?.phase).filter((p): p is string => !!p))];
  const nums = ps.filter((p) => /^\d+$/.test(p)).map(Number).sort((a, b) => a - b);
  if (nums.length && nums.length === ps.length) return nums[0] === nums.at(-1) ? `${nums[0]}` : `${nums[0]}–${nums.at(-1)}`;
  return ps.length === 1 ? ps[0]!.toUpperCase() : undefined;
}

const DECLARES = (name: string) => new RegExp(`export\\s+(?:declare\\s+)?(?:interface|class|type|abstract\\s+class)\\s+${name}\\b`);
/**
 * Code that makes a contract: a class that `implements Name`; a function that returns one (`): Name`, `): Promise<Name>`,
 * or an object holding one, `): Promise<{ catalog: Name; … }>`); or a value declared as one (`const x: Name =`).
 * A parameter typed `Name` is a use, not an implementation, and doesn't count.
 */
const IMPLEMENTS = (name: string) => new RegExp([
  `implements\\s[^{]*\\b${name}\\b`,
  `\\)\\s*:\\s*(?:Promise<\\s*)?${name}\\b`,
  `\\)\\s*:\\s*(?:Promise<\\s*)?\\{[^}]*:\\s*${name}\\b`,
  `\\b(?:const|let)\\s+\\w+\\s*:\\s*${name}\\s*=`,
].join('|'));
/** A file's code without its comments, so a declaration or a call in a comment doesn't count. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');

/** A box's fields: any other is a mistake, often a comma left unquoted in a YAML flow map ("note: a, b" makes a field "b"). */
const BOX_FIELDS = new Set(['id', 'label', 'note', 'kind', 'external', 'status', 'at', 'zone', 'part', 'view', 'contract', 'plugs', 'needs', 'text', 'code', 'tests']);

const filesOf = (facts: Facts, globs: string[] = []) => facts.sources.filter((f) => globs.some((g) => matchesGlob(f, g)));
const testFiles = (facts: Facts, globs: string[]) => globs.flatMap((g) => facts.matches(g));

/** Every way the architecture and the code disagree (empty when they agree). */
export function checkArchitecture(m: MapSource, facts: Facts): Problem[] {
  const a = m.architecture;
  if (!a) return [];
  const problems: Problem[] = [];
  const add = (rule: Rule, message: string) => problems.push({ rule, message });
  const ids = new Set<string>();
  const boxes = new Map(a.boxes.map((b) => [b.id, b]));
  const zones = new Set(a.zones.map((z) => z.id));
  const parts = new Map(m.parts.map((p) => [p.id, p]));
  const cells = new Map<string, string>();
  for (const s of a.sides) if (!zones.has(s.zone)) add('unknown-zone', `architecture.sides: no zone "${s.zone}"`);
  const sideOf = (f: string) => a.sides.find((s) => s.code.some((g) => matchesGlob(f, g)))?.zone;
  const sideZones = a.sides.map((s) => s.zone);

  for (const b of a.boxes) {
    const at = `architecture.boxes.${b.id}`;
    if (ids.has(b.id)) add('duplicate-id', `${at}: the id "${b.id}" is used twice`);
    for (const k of Object.keys(b)) if (!BOX_FIELDS.has(k)) add('unknown-field', `${at}: no field "${k}" (a comma in a flow map's value needs quotes)`);
    ids.add(b.id);
    if (b.zone && !zones.has(b.zone)) add('unknown-zone', `${at}: no zone "${b.zone}"`);
    if (b.part && !parts.has(b.part)) add('unknown-part', `${at}: no part "${b.part}" on the map`);
    if (b.view && !(m.views ?? []).some((v) => v.id === b.view)) add('unknown-view', `${at}: no view "${b.view}"`);
    const cell = b.at.join(',');
    if (cells.has(cell)) add('duplicate-id', `${at}: "${b.id}" and "${cells.get(cell)}" are both at [${cell}]`);
    cells.set(cell, b.id);
    for (const g of [...(b.code ?? []), ...(b.tests ?? [])]) if (!facts.matches(g).length) add('glob-matches-nothing', `${at}: "${g}" matches no file`);
    // Planned: names what would build it, and has no code yet.
    if (b.status === 'proposed') {
      if (!b.needs?.length) add('planned-needs-nothing', `${at}: a planned box names the requirements that would build it (needs:)`);
      else if (!phaseOf(b, facts)) add('planned-phase-unclear', `${at}: its requirements' phases (${(b.needs ?? []).map((r) => facts.requirements.get(r)?.phase ?? '?').join(', ')}) give no one phase to show`);
      const built = filesOf(facts, b.code);
      if (built.length) add('planned-part-has-code', `${at}: "${b.label}" is planned, but has code (${built[0]}): it's built, so drop status: proposed`);
    }
    for (const r of b.needs ?? []) if (!facts.requirements.has(r)) add('unknown-requirement', `${at}.needs: no requirement "${r}" in qa/traceability.yaml`);

    // A side's box holds only that side's code; an adapter for every side holds none of a side's own code.
    for (const f of filesOf(facts, b.code)) {
      const owner = sideOf(f);
      if (b.zone && sideZones.includes(b.zone) && owner !== b.zone)
        add('side-code-elsewhere', `${at}: it sits ${a.zones.find((z) => z.id === b.zone)?.label}, but ${f} is ${owner ? `${a.zones.find((z) => z.id === owner)?.label}'s` : 'no one side\'s'} code`);
      if (b.plugs && (!b.zone || !sideZones.includes(b.zone)) && owner)
        add('side-code-elsewhere', `${at}: it plugs in the same everywhere, but ${f} is ${a.zones.find((z) => z.id === owner)?.label}'s code`);
    }
    // A contract is declared where it says: one file, in its code (not a comment).
    if (b.contract) {
      // A shared contract is implemented once, in a file no side owns.
      if (b.contract.shared) {
        const sf = b.contract.shared;
        const ok = facts.matches(sf).length === 1 && IMPLEMENTS(b.contract.name).test(code(facts.text(sf)));
        if (!ok) add('adapter-not-in-code', `${at}: ${sf} doesn't implement ${b.contract.name} (it says it's implemented once, there)`);
        else if (sideOf(sf)) add('side-code-elsewhere', `${at}: it's implemented once for every side, but ${sf} is one side's code`);
      }
      const one = facts.matches(b.contract.file);
      const text = one.length === 1 && one[0] === b.contract.file ? code(facts.text(b.contract.file)) : '';
      if (!DECLARES(b.contract.name).test(text)) add('contract-not-in-code', `${at}: ${b.contract.file} ${one.length === 1 ? `declares no "${b.contract.name}"` : 'is not one file'}`);
      // Its shared suites run on both sides' adapters (a call in a comment doesn't count).
      for (const s of b.contract.suites ?? []) for (const side of ['local', 'aws'] as const) {
        const runs = testFiles(facts, a.proof[side]).some((f) => new RegExp(`\\b${s}\\(`).test(code(facts.text(f))));
        if (!runs) add('suite-not-run', `${at}: the shared suite ${s} runs in none of the ${side === 'aws' ? 'AWS' : 'local'} adapters' tests (${a.proof[side].join(', ')})`);
      }
    }
    // What plugs into a contract implements it, in its own code.
    if (b.plugs) {
      const into = boxes.get(b.plugs.into);
      if (!into?.contract) add('unknown-contract', `${at}.plugs: "${b.plugs.into}" is no contract box`);
      // What plugs into a contract implements that contract (and may implement more).
      else if (!b.plugs.implements.includes(into.contract.name))
        add('implements-other-contract', `${at}: it plugs into ${into.label}, so it implements ${into.contract.name}; it says only ${b.plugs.implements.join(', ')}`);
      const files = filesOf(facts, b.code);
      // A planned box has no code yet: what it will implement is checked once it's built.
      if (b.status !== 'proposed') for (const name of b.plugs.implements) if (!files.some((f) => IMPLEMENTS(name).test(code(facts.text(f)))))
        add('adapter-not-in-code', `${at}: none of its files implements ${name} (a class \`implements ${name}\`, a function returning one, or a value declared one)`);
    }
  }

  // Every contract is built on each side: an adapter on one machine and one in AWS, or one the same everywhere.
  for (const c of a.boxes.filter((b) => b.contract && !b.contract.shared && b.status !== 'proposed')) {
    const built = a.boxes.filter((b) => b.plugs?.into === c.id && b.status !== 'proposed');
    const everywhere = built.some((b) => !b.zone || !sideZones.includes(b.zone));
    for (const side of sideZones) if (!everywhere && !built.some((b) => b.zone === side))
      add('contract-side-missing', `architecture.boxes.${c.id}: nothing built plugs into ${c.label} ${a.zones.find((z) => z.id === side)?.label ?? side}`);
  }

  // A hand line is a link one level up (between the parts the boxes stand for), or an import between their files.
  const linked = (x: string, y: string) => (m.links ?? []).some((l) => (l.from === x && l.to === y) || (l.from === y && l.to === x));
  for (const l of a.lines ?? []) {
    const at = `architecture.lines.${l.from}-${l.to}`;
    const [x, y] = [boxes.get(l.from), boxes.get(l.to)];
    if (!x || !y) { add('unknown-part', `${at}: no box "${!x ? l.from : l.to}"`); continue; }
    if (x.part && y.part && linked(x.part, y.part)) continue;
    // A contract's own file is one of its box's files; code calls a contract through its type, so a line to a contract
    // may stand on a types-only import (to anything else, only a real one counts).
    const filesFor = (b: ArchBox) => new Set([...filesOf(facts, b.code), ...(b.contract ? [b.contract.file] : [])]);
    const [fx, fy] = [filesFor(x), filesFor(y)];
    const typesOk = !!(x.contract || y.contract);
    const imported = facts.imports.edges.some((e) => (typesOk || !e.types) && ((fx.has(e.from) && fy.has(e.to)) || (fy.has(e.from) && fx.has(e.to))));
    if (!imported) add('line-not-in-code', `${at}: neither a link between their parts on the map nor an import between their files`);
  }
  return problems;
}

/** Every piece of text a reader sees on the architecture, with where it's written (for the banned words). */
export function architectureText(a: Architecture | undefined): [string, string][] {
  if (!a) return [];
  return [
    ['architecture', [a.question, a.proof.text].join(' ')],
    ...a.zones.map((z): [string, string] => [`architecture.zones.${z.id}`, z.label]),
    ...a.boxes.map((b): [string, string] => [`architecture.boxes.${b.id}`, [b.label, b.note, b.text].filter(Boolean).join(' ')]),
    ...(a.lines ?? []).filter((l) => l.label).map((l): [string, string] => [`architecture.lines.${l.from}-${l.to}`, l.label!]),
  ];
}

/** A built contract that no shared suite proves on both sides. */
export const unprovenContract = (b: ArchBox) => !!b.contract && !b.contract.shared && b.status !== 'proposed' && !b.contract.suites?.length;
/** The words an unproven contract carries on the drawing, in place of its note. */
export const UNPROVEN = 'no shared tests yet';

/** The spec the renderer draws: the boxes, the lines written by hand, and a line from each contract to what plugs in. */
export function architectureSpec(m: MapSource, facts: Facts): Record<string, unknown> {
  const a = m.architecture!;
  const views = (m.views ?? []).map((v) => v.id);
  const boxes = new Map(a.boxes.map((b) => [b.id, b]));
  const planned = (id: string) => boxes.get(id)?.status === 'proposed';
  const page = (b: ArchBox) => (b.part ? (b.view ? [b.view] : views).map((v) => pageOf(m, b.part!, v)).find(Boolean) : undefined);
  const parts = a.boxes.map((b) => {
    const pg = page(b);
    const phase = b.status === 'proposed' ? phaseOf(b, facts) : undefined;
    // What to notice: a contract no shared suite proves on both sides (swapping its side isn't shown to work), in words too.
    const unproven = unprovenContract(b);
    const note = unproven ? UNPROVEN : b.note;
    return {
      id: b.id, label: b.label, ...(note ? { note } : {}), kind: b.kind ?? 'service', external: !!b.external,
      ...(unproven ? { emphasis: 'alert' } : {}),
      ...(b.status === 'proposed' ? { status: 'proposed' } : {}), ...(phase ? { phase } : {}),
      at: b.at, ...(b.zone ? { zone: b.zone } : {}), ...(pg ? { href: `${pg.id}.html` } : {}),
    };
  });
  const lines = (a.lines ?? []).map((l) => ({ ...l, arrow: 'forward', ...(planned(l.from) || planned(l.to) ? { status: 'proposed' } : {}) }));
  const plugs = a.boxes.filter((b) => b.plugs).map((b) => ({ from: b.plugs!.into, to: b.id, ...(planned(b.id) ? { status: 'proposed' } : {}) }));
  return {
    kind: 'system-map', title: m.title, question: a.question, alertWord: 'waits',
    zones: a.zones.map((z) => ({ id: z.id, label: z.label, style: z.style ?? 'region' })),
    parts, links: [...lines, ...plugs], flows: [],
  };
}
