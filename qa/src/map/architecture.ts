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
  /** A contract: the interface (or class) the rest is written against, and the file that declares it. */
  contract?: { name: string; file: string; suites?: string[] };
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
/** Code that implements a contract: `implements Name`, or a value typed as one (`: Name`, `: Promise<Name>`). */
const IMPLEMENTS = (name: string) => new RegExp(`implements\\s[^{]*\\b${name}\\b|:\\s*(?:Promise<\\s*)?${name}\\b`);

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
      const built = filesOf(facts, b.code);
      if (built.length) add('planned-part-has-code', `${at}: "${b.label}" is planned, but has code (${built[0]}): it's built, so drop status: proposed`);
    }
    for (const r of b.needs ?? []) if (!facts.requirements.has(r)) add('unknown-requirement', `${at}.needs: no requirement "${r}" in qa/traceability.yaml`);

    // A contract is declared where it says.
    if (b.contract) {
      const text = facts.matches(b.contract.file).length ? facts.text(b.contract.file) : '';
      if (!DECLARES(b.contract.name).test(text)) add('contract-not-in-code', `${at}: ${b.contract.file} declares no "${b.contract.name}"`);
      // Its shared suites run on both sides' adapters.
      for (const s of b.contract.suites ?? []) for (const side of ['local', 'aws'] as const) {
        const runs = testFiles(facts, a.proof[side]).some((f) => new RegExp(`\\b${s}\\(`).test(facts.text(f)));
        if (!runs) add('suite-not-run', `${at}: the shared suite ${s} runs in none of the ${side === 'aws' ? 'AWS' : 'local'} adapters' tests (${a.proof[side].join(', ')})`);
      }
    }
    // What plugs into a contract implements it, in its own code.
    if (b.plugs) {
      const into = boxes.get(b.plugs.into);
      if (!into?.contract) add('unknown-contract', `${at}.plugs: "${b.plugs.into}" is no contract box`);
      const files = filesOf(facts, b.code);
      // A planned box has no code yet: what it will implement is checked once it's built.
      if (b.status !== 'proposed') for (const name of b.plugs.implements) if (!files.some((f) => IMPLEMENTS(name).test(facts.text(f))))
        add('adapter-not-in-code', `${at}: none of its files implements ${name} (\`implements ${name}\`, or a value typed ${name})`);
    }
  }

  // A hand line is a link one level up (between the parts the boxes stand for), or an import between their files.
  const linked = (x: string, y: string) => (m.links ?? []).some((l) => (l.from === x && l.to === y) || (l.from === y && l.to === x));
  for (const l of a.lines ?? []) {
    const at = `architecture.lines.${l.from}-${l.to}`;
    const [x, y] = [boxes.get(l.from), boxes.get(l.to)];
    if (!x || !y) { add('unknown-part', `${at}: no box "${!x ? l.from : l.to}"`); continue; }
    if (x.part && y.part && linked(x.part, y.part)) continue;
    const [fx, fy] = [new Set(filesOf(facts, x.code)), new Set(filesOf(facts, y.code))];
    const imported = facts.imports.edges.some((e) => !e.types && ((fx.has(e.from) && fy.has(e.to)) || (fy.has(e.from) && fx.has(e.to))));
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
    return {
      id: b.id, label: b.label, ...(b.note ? { note: b.note } : {}), kind: b.kind ?? 'service', external: !!b.external,
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
