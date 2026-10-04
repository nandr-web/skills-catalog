// npm run map (in qa/): checks docs/map/map.yaml and docs/decisions.yaml against the code, then writes:
//   docs/map/index.html            the architecture at a high level: who uses it, the contracts, one box per side, planned
//   docs/map/ports.html            one level down: each port, and what plugs into it on one machine and in AWS
//   docs/map/use-cases.html        use cases: step through the core loop (click a part for its code and tests)
//   docs/map/context.html          who uses it and where each copy runs (planned on a toggle), and the code's packages
//   docs/map/decisions.html        every decision, with the parts it's about and the options weighed
//   docs/map/<part>.html           a page per part (map.yaml pages:): its insides, read from the code
//   docs/pictures/map-<view>.svg   each view's overview, for the README and docs/architecture.md
//   docs/pictures/map-<flow>.svg   the held update step, on one machine, with its steps in words under it
// Drawn by the diagram renderer, vendored as renderer.js (scripts/vendor-renderer.ts). No AI, no network: the
// same map, decisions and code give the same files, byte for byte (the map test compares a fresh build with the files
// on disk).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { checkDecisions, DECISIONS_SOURCE, type DecisionLog } from './decisions.ts';
import { readFacts, type Facts } from './facts.ts';
import { checkMap, type MapSource, type Problem } from './map.ts';
import { phoneProblems } from './phone.ts';
import { drawSystemMap, layoutSystemMap, parseSystemMap } from './renderer.js';
import { buildSite, useCaseSpec } from './site.ts';

/** The repo's root, as an absolute path. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SOURCE = 'docs/map/map.yaml';
export const PAGE = 'docs/map/index.html';
/** The pictures: each view's overview, and the steps worth a still picture of their own. */
export const PICTURE_FLOWS = ['held-update'];
export const picturePath = (name: string) => `docs/pictures/map-${name}.svg`;

export type Built = { files: Map<string, string>; problems: Problem[]; warnings: string[] };
export type Sources = { map?: MapSource; decisions?: DecisionLog; facts?: Facts };

/** Every id a decision may name: the map's parts, and the boxes on the parts' pages. */
export const mapIds = (m: MapSource) => new Set([...m.parts.map((p) => p.id), ...(m.pages ?? []).flatMap((pg) => pg.boxes.map((b) => b.id))]);

export async function buildMap(root = ROOT, given: Sources = {}): Promise<Built> {
  const m = given.map ?? (parse(readFileSync(join(root, SOURCE), 'utf8')) as MapSource);
  const log = given.decisions ?? (parse(readFileSync(join(root, DECISIONS_SOURCE), 'utf8')) as DecisionLog);
  const facts = given.facts ?? readFacts(root);
  const problems = [...checkMap(m, facts, (p) => existsSync(join(root, p))), ...checkDecisions(log, mapIds(m))];
  const files = new Map<string, string>();
  if (problems.length) return { files, problems, warnings: [] };

  const site = await buildSite(m, facts, log, m.codeBase);
  for (const [path, text] of site.files) files.set(path, text);
  // The pictures: what's built today (no planned parts), as a README shows them.
  const { spec: parsed } = parseSystemMap(useCaseSpec({ m, facts }));
  const views = parsed.views.length ? parsed.views.map((v) => v.id) : [''];
  for (const view of views) {
    const L = layoutSystemMap(parsed, view);
    files.set(picturePath(view || 'overview'), drawSystemMap(parsed, L, undefined, { idPrefix: `map-${view || 'overview'}` }) + '\n');
    for (const id of PICTURE_FLOWS) if (view === views[0]) {
      const i = parsed.flows.findIndex((f) => f.id === id);
      if (i < 0) problems.push({ rule: 'unknown-flow', message: `PICTURE_FLOWS: no flow "${id}"` });
      else files.set(picturePath(id), drawSystemMap(parsed, L, i, { idPrefix: `map-${id}`, legend: true }) + '\n');
    }
  }
  for (const [path, svg] of files) if (path.endsWith('.svg')) problems.push(...phoneProblems(path, svg));
  return { files, problems, warnings: site.warnings };
}

/** Every page without its script: every view and box laid out at once (for the page check, not committed). */
export async function buildStatic(root = ROOT): Promise<Map<string, string>> {
  const m = parse(readFileSync(join(root, SOURCE), 'utf8')) as MapSource;
  const log = parse(readFileSync(join(root, DECISIONS_SOURCE), 'utf8')) as DecisionLog;
  return (await buildSite(m, readFacts(root), log, m.codeBase, { static: true })).files;
}

/** Write the built files (only when the map and the code agree, and every picture reads on a phone). */
export function writeBuilt(root: string, built: Built): void {
  for (const [path, text] of built.files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = await buildMap();
  for (const w of built.warnings) console.error(`warning: ${w}`);
  if (built.problems.length) {
    console.error(`The map and the code disagree (${SOURCE}, ${DECISIONS_SOURCE}); nothing written:\n${built.problems.map((p) => `  [${p.rule}] ${p.message}`).join('\n')}`);
    process.exit(1);
  }
  writeBuilt(ROOT, built);
  console.log(`wrote ${[...built.files.keys()].join(', ')}`);
}
