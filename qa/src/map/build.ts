// npm run map (in qa/): checks docs/map/map.yaml against the code, then writes the system map's page and pictures:
//   docs/map/index.html            the interactive page (step through the core loop; click a part for its code and tests)
//   docs/pictures/map-<view>.svg   each view's overview, for the README and docs/architecture.md
//   docs/pictures/map-<flow>.svg   the held update step, on one machine, with its steps in words under it
// Drawn by the diagram renderer, vendored as renderer.js (scripts/vendor-renderer.ts). No AI, no network: the
// same map and code give the same files, byte for byte (the map test compares a fresh build with the files on disk).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { readFacts } from './facts.ts';
import { checkMap, toSpec, type MapSource, type Problem } from './map.ts';
import { phoneProblems } from './phone.ts';
import { buildSystemMapFrom, drawSystemMap, layoutSystemMap, parseSystemMap } from './renderer.js';

/** The repo's root, as an absolute path. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SOURCE = 'docs/map/map.yaml';
export const PAGE = 'docs/map/index.html';
/** The pictures: each view's overview, and the steps worth a still picture of their own. */
export const PICTURE_FLOWS = ['held-update'];
export const picturePath = (name: string) => `docs/pictures/map-${name}.svg`;

export type Built = { files: Map<string, string>; problems: Problem[]; warnings: string[] };

export async function buildMap(root = ROOT, source?: MapSource): Promise<Built> {
  const m = source ?? (parse(readFileSync(join(root, SOURCE), 'utf8')) as MapSource);
  const facts = readFacts(root);
  const problems = checkMap(m, facts, (p) => existsSync(join(root, p)));
  const files = new Map<string, string>();
  if (problems.length) return { files, problems, warnings: [] };

  const spec = toSpec(m, facts, dirname(PAGE));
  const page = await buildSystemMapFrom(spec);
  files.set(PAGE, page.html + '\n');
  const { spec: parsed } = parseSystemMap(spec);
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
  return { files, problems, warnings: page.warnings };
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
    console.error(`The map and the code disagree (${SOURCE}); nothing written:\n${built.problems.map((p) => `  [${p.rule}] ${p.message}`).join('\n')}`);
    process.exit(1);
  }
  writeBuilt(ROOT, built);
  console.log(`wrote ${[...built.files.keys()].join(', ')}`);
}
