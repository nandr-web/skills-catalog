// The discovery corpus (golden/queries.yaml) as skills to publish, and the seeded scale catalog that embeds it
// unchanged (the QA plan's "Scale" set: 10,000 skills generated from a seed, the 64 embedded).

import { loadGolden } from './golden.ts';

export interface SeedSkill {
  name: string;
  files: { path: string; mode: string; content_base64: string }[];
}

function skillMd(name: string, description: string, body: string): string {
  const title = name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n# ${title}\n\n${body}\n`;
}

function seed(name: string, description: string, body: string): SeedSkill {
  return { name, files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(skillMd(name, description, body)).toString('base64') }] };
}

export function discoveryCorpus(): SeedSkill[] {
  const q = loadGolden('queries.yaml');
  return q.corpus.map((c: any) => seed(c.name, c.description, c.body_gist ?? 'Follow the steps.'));
}

// A small seeded generator (mulberry32), so the scale catalog is the same on every run.
function rng(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ['drafts', 'reviews', 'checks', 'plans', 'generates', 'audits', 'summarises', 'migrates', 'formats', 'tests', 'profiles', 'documents'];
const OBJECTS = ['terraform', 'kubernetes', 'invoices', 'dashboards', 'queries', 'schemas', 'tickets', 'runbooks', 'contracts', 'budgets', 'alerts', 'pipelines', 'fixtures', 'reports', 'roadmaps', 'backlogs', 'webhooks', 'certificates', 'datasets', 'playbooks'];
const CONTEXTS = ['for the platform team', 'before a release', 'in pull requests', 'for customer support', 'across services', 'for finance', 'in staging', 'for onboarding', 'during incidents', 'for audits'];
const TOOLS = ['helm', 'grafana', 'jira', 'dbt', 'kafka', 'redis', 'postgres', 'snowflake', 'airflow', 'argo', 'vault', 'sentry', 'datadog', 'pulumi', 'ansible'];

// n skills: the discovery corpus first, then generated neighbours, all with distinct names.
export function scaleCorpus(n = 10_000, seedValue = 20260928): SeedSkill[] {
  const out = discoveryCorpus();
  const names = new Set(out.map((s) => s.name));
  const r = rng(seedValue);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  for (let i = 0; out.length < n; i++) {
    const verb = pick(VERBS);
    const obj = pick(OBJECTS);
    const tool = pick(TOOLS);
    const name = `${tool}-${obj}-${verb.replace(/s$/, '')}-${i.toString(36)}`;
    if (names.has(name)) continue;
    names.add(name);
    const description = `${verb[0]!.toUpperCase()}${verb.slice(1)} ${obj} with ${tool} ${pick(CONTEXTS)}. Use when working on ${pick(OBJECTS)} or ${pick(OBJECTS)}.`;
    out.push(seed(name, description, `1. Gather the ${obj}.\n2. Run ${tool}.\n3. Report what changed.`));
  }
  return out;
}
