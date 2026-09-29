// One publish from its own process, for the "nothing lost" test: node publish-one.ts <catalog dir> <variant n>. It
// prints "ready" once its imports are loaded, then waits for the start time the test sends every process on stdin, so
// the publishes really overlap however long each process took to start.

import { actAs, openLocalCatalog } from '../../src/local/index.ts';
import { startTogether } from './together.ts';

const [dir, n] = process.argv.slice(2) as [string, string];
await startTogether();
const catalog = await openLocalCatalog(dir);
const skillMd = `---\nname: concurrent-skill\ndescription: A checklist for reviewing pull requests (tests, naming, security, docs). Use when asked to review a PR.\n---\nWork through checklist.md item by item.\nVariant ${n}.\n`;
const checklist = '- [ ] Tests cover the change\n- [ ] Names say what things are\n- [ ] No secrets\n';
const files = [
  { path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(skillMd).toString('base64') },
  { path: 'checklist.md', mode: '0644', content_base64: Buffer.from(checklist).toString('base64') },
];
try {
  const r = await catalog.publish({ name: 'concurrent-skill', files }, actAs('ana'));
  process.stdout.write(JSON.stringify({ n: Number(n), version: r.version, created: r.created, fingerprint: r.fingerprint }));
} finally {
  catalog.close();
}
