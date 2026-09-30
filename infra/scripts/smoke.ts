// The smoke test of a deployed catalog: npm run smoke -- --url <CatalogUrl> [--api <the HTTP API's own URL>]
// Without a token it checks the guards: the API answers only through the edge, and only with a token. With SKILLS_TOKEN
// (skills-catalog login's, or a personal one) it runs the client's own path: publish a new skill through upload links,
// find it, read it, fetch its bytes back through their links and compare, publish a second version with a script and
// see the risk flag and the diff. Each step prints ok or FAIL; the exit code is the count of FAILs. It writes to the
// catalog (one skill named smoke-<time>); it deletes nothing (a catalog never deletes a version).

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CatalogError, openCatalog } from '../../core/src/index.ts';

const { values } = parseArgs({ options: { url: { type: 'string' }, api: { type: 'string' } } });
const url = values.url?.replace(/\/+$/, '');
if (!url?.startsWith('https://')) {
  console.error('smoke: --url <CatalogUrl> (https://…) is needed');
  process.exit(2);
}
let failed = 0;
const check = async (what: string, f: () => Promise<unknown>) => {
  try {
    const note = await f();
    console.log(`ok    ${what}${note ? `: ${String(note)}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
};
const expect = (cond: unknown, why: string) => {
  if (!cond) throw new Error(why);
};
const post = (base: string, op: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

await check('the page answers at the edge', async () => {
  const r = await fetch(`${url}/`);
  return `${r.status}, ${r.headers.get('content-security-policy') ? 'with' : 'without'} a content security policy`;
});
await check('without a token the API says unauthenticated (401, Bearer)', async () => {
  const r = await post(url, 'search_shared_skills', { query: 'x' });
  const body = (await r.json()) as { error?: { code?: string } };
  expect(r.status === 401 && r.headers.get('www-authenticate') === 'Bearer' && body.error?.code === 'unauthenticated', `got ${r.status} ${JSON.stringify(body)}`);
});
await check('a made-up token is refused the same way', async () => {
  const r = await post(url, 'search_shared_skills', { query: 'x' }, { authorization: 'Bearer made-up-token-0123456789' });
  expect(r.status === 401, `got ${r.status}`);
});
await check('the acting-as header is refused (400)', async () => {
  const r = await post(url, 'search_shared_skills', { query: 'x' }, { 'x-skills-catalog-as': 'ana' });
  expect(r.status === 400, `got ${r.status}`);
});
if (values.api) {
  await check("the API's own address, skipping the edge, is refused (403)", async () => {
    const r = await post(values.api!.replace(/\/+$/, ''), 'search_shared_skills', { query: 'x' });
    expect(r.status === 403, `got ${r.status}`);
  });
}
await check('a sign-in with a GitHub token GitHub never issued is refused', async () => {
  const r = await post(url, 'sign_in_with_github', { github_token: 'gho_' + 'x'.repeat(36), scope: 'read' });
  const body = (await r.json()) as { ok?: boolean; error?: { code?: string } };
  expect(body.ok === false, `got ${JSON.stringify(body)}`);
  return body.error?.code;
});

const token = process.env['SKILLS_TOKEN'];
if (!token) {
  console.log('--    no SKILLS_TOKEN: the signed-in steps are skipped (skills-catalog login, then run again)');
} else {
  const catalog = await openCatalog(url, { token });
  const name = `smoke-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const v1 = [
    { path: 'SKILL.md', mode: '0644', content_base64: b64(`---\nname: ${name}\ndescription: A smoke test's skill for checking a deployed catalog end to end.\n---\nSay hello.\n`) },
    { path: 'notes.md', mode: '0644', content_base64: b64('# Notes\n') },
  ];
  const v2 = [...v1, { path: 'scripts/hello.sh', mode: '0755', content_base64: b64('#!/bin/sh\necho hello\n') }];
  const none = undefined as never;
  await check(`publish ${name} v1 through upload links`, async () => {
    const r = await catalog.publish({ name, files: v1, message: 'smoke test' }, none, 'mcp');
    expect(r.version === 1, `version ${r.version}`);
    return r.fingerprint;
  });
  await check('search finds it (the indexer runs seconds after a publish)', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await catalog.search({ query: "smoke test's skill" }, 'mcp');
      if (r.results.some((s) => s.name === name)) return `after ${i * 3} s`;
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error('not found after 60 s');
  });
  await check('read it', async () => {
    const r = await catalog.read({ name }, 'mcp');
    expect(JSON.stringify(r).includes('Say hello.'), 'SKILL.md not in the answer');
  });
  await check('fetch its bytes back through their links, fingerprint-equal', async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const r = await catalog.fetch({ name, version: 1 }, 'mcp');
        const got = [...r.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}:${createHash('sha256').update(Buffer.from((f as { content_base64: string }).content_base64, 'base64')).digest('hex')}`);
        const want = [...v1].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}:${createHash('sha256').update(Buffer.from(f.content_base64, 'base64')).digest('hex')}`);
        expect(JSON.stringify(got) === JSON.stringify(want), 'the bytes differ');
        return `${r.files.length} files`;
      } catch (e) {
        if (i === 19 || e instanceof CatalogError) throw e;
        await new Promise((res) => setTimeout(res, 3000)); // a file named seconds ago may still be on its way
      }
    }
  });
  await check('v2 adds a script: flagged, and the diff says it can run', async () => {
    const r = await catalog.publish({ name, files: v2 }, none, 'mcp');
    expect(r.version === 2 && r.risk_flags.some((f) => f.kind === 'runnable_file'), JSON.stringify(r.risk_flags));
    const d = await catalog.diff({ name, from: 1, to: 2 }, 'mcp');
    expect(d.files.some((f) => f.path === 'scripts/hello.sh'), 'no script in the diff');
  });
  await check('versions lists both, newest first', async () => {
    const r = await catalog.versions({ name }, 'mcp');
    expect(JSON.stringify(r.versions.map((v) => v.version)) === '[2,1]', JSON.stringify(r.versions.map((v) => v.version)));
  });
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exitCode = failed;
