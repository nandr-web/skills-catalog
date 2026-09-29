// The stack's functions (the AWS build brief, slice 3): the API, the indexer and the sweep, each on Node 24 (the
// runtime slice 1's search needs: node:sqlite with FTS5; the smoke test checks the version) and bundled by the local
// esbuild, never Docker. Who may delete: only the sweep may delete a skill file; nothing deletes a record.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, it } from 'vitest';
import { synth } from './synth.ts';

type Statement = { Effect: string; Action: string | string[]; Resource?: unknown };
type Resources = Record<string, { Type: string; Properties?: Record<string, any> }>;

/** Every action a function's role is allowed, from the policies attached to it. */
function allowed(t: Template, fn: string): string[] {
  const res = t.toJSON().Resources as Resources;
  const [, f] = Object.entries(res).find(([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith(fn))!;
  const role = (f.Properties!['Role'] as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
  const actions: string[] = [];
  for (const r of Object.values(res)) {
    if (r.Type !== 'AWS::IAM::Policy') continue;
    if (!(r.Properties!['Roles'] as { Ref: string }[]).some((x) => x.Ref === role)) continue;
    for (const s of r.Properties!['PolicyDocument'].Statement as Statement[]) if (s.Effect === 'Allow') actions.push(...[s.Action].flat());
  }
  return actions;
}
// Anything that can delete: a delete action, a batch write (it deletes too), a PartiQL delete, or any wildcard.
const deletes = (actions: string[]) => actions.filter((a) => /^s3:Delete|^dynamodb:(DeleteItem|BatchWriteItem|PartiQLDelete)$|\*/.test(a));
/** Every allowed action that could delete or reaches too wide, in a standalone policy or inline on a role. */
function badActions(t: Template): string[] {
  const bad: string[] = [];
  const check = (where: string, doc: { Statement: Statement[] }) => {
    for (const s of doc.Statement) for (const a of [s.Action].flat()) if (s.Effect === 'Allow' && /\*|^dynamodb:(DeleteItem|BatchWriteItem|PartiQLDelete)$/.test(a)) bad.push(`${where}: ${a}`);
  };
  for (const [id, r] of Object.entries(t.toJSON().Resources as Resources)) {
    if (r.Type === 'AWS::IAM::Policy') check(id, r.Properties!['PolicyDocument']);
    if (r.Type === 'AWS::IAM::Role') for (const p of (r.Properties!['Policies'] ?? []) as { PolicyDocument: { Statement: Statement[] } }[]) check(id, p.PolicyDocument);
    // Resource policies grant too: a bucket or queue policy's Allow reaches whoever it names.
    if (r.Type === 'AWS::S3::BucketPolicy' || r.Type === 'AWS::SQS::QueuePolicy') check(id, r.Properties!['PolicyDocument']);
  }
  return bad.map((b) => b.replace(/^([A-Za-z]+?)[0-9A-F]{8}:/, '$1:')).sort();
}
// Throwaway empties its buckets when the stack goes: each bucket policy lets the CDK's own auto-delete provider list and
// delete every object. That's the stack's teardown, never a request path, and demo has none of it.
const THROWAWAY_ONLY = ['SitePagesPolicy', 'StorageFilesPolicy'].flatMap((b) => ['s3:DeleteObject*', 's3:GetBucket*', 's3:List*'].map((a) => `${b}: ${a}`)).sort();
const dynamo = (actions: string[]) => actions.filter((a) => a.startsWith('dynamodb:')).sort();

describe('functions', () => {
  // A fake docker first on PATH: bundling that fell back to Docker would leave its mark.
  const bin = mkdtempSync(join(tmpdir(), 'no-docker-'));
  const mark = join(bin, 'docker-was-called');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\ntouch '${mark}'\nexit 1\n`, { mode: 0o755 });
  const path = process.env['PATH'];
  process.env['PATH'] = [bin, '/usr/bin', '/bin', dirname(process.execPath)].join(':');
  let t: Template;
  try {
    t = synth('throwaway');
  } finally {
    process.env['PATH'] = path;
  }
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  it('synth bundles with the local esbuild and never calls Docker', () => {
    expect(existsSync(mark)).toBe(false);
  });

  it('three functions, each on nodejs24.x, arm64', () => {
    const fns = t.findResources('AWS::Lambda::Function', { Properties: { Runtime: 'nodejs24.x' } });
    expect(Object.keys(fns).filter((id) => /^(Api|Indexer|Sweep)/.test(id)).length).toBe(3);
    for (const [id, f] of Object.entries(fns)) if (/^(Api|Indexer|Sweep)/.test(id)) expect((f as any).Properties.Architectures, id).toEqual(['arm64']);
  });

  it('each function is given the table and the bucket by name, and logs to its own log group', () => {
    const fns = Object.entries(t.findResources('AWS::Lambda::Function')).filter(([id]) => /^(Api|Indexer|Sweep)/.test(id));
    expect(fns.length).toBe(3);
    for (const [id, f] of fns) {
      const p = (f as any).Properties;
      expect(p.Handler, id).toBe('index.handler');
      expect(Object.keys(p.Environment.Variables), id).toEqual(expect.arrayContaining(['CATALOG_TABLE', 'CATALOG_BUCKET']));
      expect(p.LoggingConfig?.LogGroup, id).toBeDefined();
    }
  });

  it("the API's records are exactly what reads and the commit's transaction need: never a delete or a batch write", () => {
    expect(dynamo(allowed(t, 'Api'))).toEqual(['dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
  });

  it('no role anywhere in the stack, in a policy or inline, gets a wildcard action or a DynamoDB batch write or delete', () => {
    expect(badActions(t)).toEqual(THROWAWAY_ONLY);
    expect(badActions(synth('demo'))).toEqual([]);
  });

  it('the API and the indexer can delete nothing; the API can tag files (claims)', () => {
    const api = allowed(t, 'Api');
    expect(deletes(api)).toEqual([]);
    expect(api).toContain('s3:PutObjectTagging');
    expect(deletes(allowed(t, 'Indexer'))).toEqual([]);
  });

  it('only the sweep deletes, and only skill files: s3:DeleteObject on blobs/*, never a record', () => {
    const sweep = allowed(t, 'Sweep');
    expect(deletes(sweep)).toEqual(['s3:DeleteObject']);
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 's3:DeleteObject', Resource: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith(['/blobs/*'])]) }) })]) },
    });
  });
});
