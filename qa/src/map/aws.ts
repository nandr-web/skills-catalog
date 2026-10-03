// What the hosted catalog is made of in AWS, read from the stack's template as infra's tests pin it
// (infra/test/__snapshots__/snapshot.test.ts.snap, which fails infra's check when the stack changes without it): every
// resource, which resource names which (Ref, GetAtt, Sub), and what each resource may do to which through the role it
// runs as (its IAM policies). No AWS account and no CDK run: the same pinned template always gives the same facts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TEMPLATE_SNAPSHOT = 'infra/test/__snapshots__/snapshot.test.ts.snap';
/** The preset the map shows: the demo stack (alarms and a budget on top of the throwaway one). */
export const TEMPLATE_PRESET = 'demo';

export type AwsResource = { id: string; type: string };
/** `from` names `to` in its properties. `allows`: `from` is a policy or permission naming who may use it, which says
 *  who may, not who does (what each does is in `access`). */
export type AwsRef = { from: string; to: string; allows: boolean };

/** Resources that grant rather than use: a policy, a permission. */
const GRANTS = new Set(['AWS::IAM::Policy', 'AWS::IAM::Role', 'AWS::S3::BucketPolicy', 'AWS::SQS::QueuePolicy', 'AWS::SNS::TopicPolicy', 'AWS::Lambda::Permission']);
/** `from` may do `actions` to `to`, through the role it runs as. */
export type AwsAccess = { from: string; to: string; actions: string[] };
export type AwsFacts = { resources: AwsResource[]; refs: AwsRef[]; access: AwsAccess[] };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Resource = { Type: string; Properties?: Json };

/** The template JSON from vitest's snapshot file: a template literal around a quoted string, \\, \` and \${ escaped. */
export function templateFromSnapshot(snap: string, preset: string): { Resources: Record<string, Resource> } {
  const m = snap.match(new RegExp(`exports\\[\`the ${preset} template > [^\`]*\`\\] = \`\\n"([\\s\\S]*?)"\\n\`;`));
  if (!m) throw new Error(`no "${preset}" template in ${TEMPLATE_SNAPSHOT}`);
  return JSON.parse(m[1]!.replace(/\\([\s\S])/g, '$1'));
}

/** Every resource id a value names: { Ref }, { Fn::GetAtt }, and ${Id} or ${Id.Attr} inside Fn::Sub. */
function named(v: Json, ids: Set<string>, out: Set<string>): Set<string> {
  if (Array.isArray(v)) for (const x of v) named(x, ids, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (k === 'Ref' && typeof x === 'string' && ids.has(x)) out.add(x);
    else if (k === 'Fn::GetAtt') {
      const id = Array.isArray(x) ? x[0] : typeof x === 'string' ? x.split('.')[0] : undefined;
      if (typeof id === 'string' && ids.has(id)) out.add(id);
    } else if (k === 'Fn::Sub') {
      const s = Array.isArray(x) ? x[0] : x;
      if (typeof s === 'string') for (const m of s.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}/g)) if (ids.has(m[1]!)) out.add(m[1]!);
      if (Array.isArray(x)) named(x[1] ?? null, ids, out);
    } else named(x, ids, out);
  }
  return out;
}

export function readAws(root: string, preset = TEMPLATE_PRESET): AwsFacts {
  const t = templateFromSnapshot(readFileSync(join(root, TEMPLATE_SNAPSHOT), 'utf8'), preset);
  const ids = new Set(Object.keys(t.Resources));
  const resources = Object.entries(t.Resources).map(([id, r]) => ({ id, type: r.Type })).sort((a, b) => a.id.localeCompare(b.id));

  const refs: AwsRef[] = [];
  for (const [id, r] of Object.entries(t.Resources)) for (const to of named(r.Properties ?? null, ids, new Set()))
    if (to !== id) refs.push({ from: id, to, allows: GRANTS.has(r.Type) });

  // Each role's policies: the actions it allows on each resource. Then everything that runs as that role (names it as
  // its Role or RoleArn) gets them.
  const allowed = new Map<string, Map<string, Set<string>>>(); // role → resource → actions
  for (const [, r] of Object.entries(t.Resources)) {
    if (r.Type !== 'AWS::IAM::Policy') continue;
    const p = r.Properties as { Roles?: Json; PolicyDocument?: { Statement?: { Effect?: string; Action?: Json; Resource?: Json }[] } };
    const roles = named(p.Roles ?? null, ids, new Set());
    for (const s of p.PolicyDocument?.Statement ?? []) {
      if (s.Effect !== 'Allow') continue;
      const actions = (Array.isArray(s.Action) ? s.Action : [s.Action]).filter((a): a is string => typeof a === 'string');
      for (const target of named(s.Resource ?? null, ids, new Set())) for (const role of roles) {
        const byTarget = allowed.get(role) ?? new Map<string, Set<string>>();
        allowed.set(role, byTarget);
        const set = byTarget.get(target) ?? new Set<string>();
        byTarget.set(target, set);
        for (const a of actions) set.add(a);
      }
    }
  }
  const access: AwsAccess[] = [];
  for (const [id, r] of Object.entries(t.Resources)) {
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::Role') continue;
    const props = (r.Properties ?? {}) as Record<string, Json>;
    for (const role of named([props.Role ?? null, props.RoleArn ?? null], ids, new Set()))
      for (const [to, actions] of allowed.get(role) ?? []) access.push({ from: id, to, actions: [...actions].sort() });
  }
  const order = <T extends { from: string; to: string }>(a: T, b: T) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
  return { resources, refs: refs.sort(order), access: access.sort(order) };
}

/** The words accessWords uses, in the order a label lists them. */
export const ACCESS_WORDS = ['reads', 'writes', 'receives', 'sends', 'invokes'] as const;

/** A few words for what a set of IAM actions does: reads, writes, receives (from a queue), sends, invokes (a label). */
export function accessWords(actions: readonly string[]): string {
  const words = new Set<string>();
  for (const a of actions) {
    const [service = '', verb = a] = a.includes(':') ? a.split(':') : ['', a];
    if (service === 'sqs') {
      if (/^(ReceiveMessage|DeleteMessage|ChangeMessageVisibility|GetQueue)/.test(verb)) words.add('receives');
      if (/^SendMessage/.test(verb)) words.add('sends');
      continue;
    }
    if (/^(Get|List|Query|Scan|Describe|BatchGet|ConditionCheck)/.test(verb) || verb === '*') words.add('reads');
    if (/^(Put|Update|Delete|BatchWrite|Transact|Create|Abort)/.test(verb) || verb === '*') words.add('writes');
    if (/^Publish/.test(verb)) words.add('sends');
    if (/^Invoke/.test(verb)) words.add('invokes');
  }
  return ACCESS_WORDS.filter((w) => words.has(w)).join(', ');
}
