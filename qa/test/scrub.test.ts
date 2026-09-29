// Scrubbing a trace before it becomes a test fixture: the home folder, the sandbox path and every session id are
// replaced, so a fixture never carries a person's paths, and a replayed trace never names a real session's folders.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scrubTrace } from '../src/agent/scrub.ts';
import { realHome } from '../src/safe-delete.ts';

const HOME = realHome();
const SANDBOX = '/private/var/folders/ab/xyz/T/skills-catalog-qa/20260929T001234Z-1a2b3c4d';
const planted = [
  { type: 'system', subtype: 'init', session_id: '6f94571b-9207-4acd-a44e-1eb29b9f0244', cwd: `${SANDBOX}/work`, tools: [] },
  { type: 'assistant', session_id: '6f94571b-9207-4acd-a44e-1eb29b9f0244', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${HOME}/.claude/settings.json` } }] } },
  { type: 'user', session_id: '1da55bba-b2b6-4695-a0c5-2b78d250586c', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `see ${SANDBOX}/catalog and ${HOME}/notes` }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: '1da55bba-b2b6-4695-a0c5-2b78d250586c' },
].map((l) => JSON.stringify(l)).join('\n') + '\n';

describe('scrubbing a trace before it becomes a fixture', () => {
  const out = scrubTrace(planted, { sandboxRoot: SANDBOX });

  it('leaves none of the planted markers: the home folder, the sandbox path, the real session ids', () => {
    for (const marker of [HOME, SANDBOX, '6f94571b-9207-4acd-a44e-1eb29b9f0244', '1da55bba-b2b6-4695-a0c5-2b78d250586c']) expect(out, marker).not.toContain(marker);
  });

  it('puts stand-ins in their place, one fake id per session, in order of appearance', () => {
    expect(out).toContain('$SANDBOX/work');
    expect(out).toContain('/Users/qa-user/.claude/settings.json');
    const ids = [...new Set(out.match(/"session_id":"([^"]+)"/g))];
    expect(ids).toEqual(['"session_id":"00000000-0000-4000-8000-000000000001"', '"session_id":"00000000-0000-4000-8000-000000000002"']);
  });

  it('keeps every line valid JSON', () => {
    for (const l of out.trim().split('\n')) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('redacts secrets in the usual formats (the documented example AWS key is kept: it is no secret)', () => {
    const secrets = {
      anthropic: 'sk-ant-api03-' + 'a'.repeat(40),
      aws: 'AKIA' + 'QZ7Y2X4W6V8U0T1S',
      github: 'ghp_' + 'b'.repeat(36),
      github_fine: 'github_pat_' + 'c'.repeat(30),
      slack: 'xoxb-' + '1234567890-abcdefghij',
      npm: 'npm_' + 'd'.repeat(36),
      private_key: ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----\\nabc\\n-----END OPENSSH ', 'PRIVATE KEY-----'].join(''),   // split, so this file holds no key header
    };
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: Object.values(secrets).join(' ') + ' AKIAIOSFODNN7EXAMPLE' }] } });
    const out = scrubTrace(line + '\n', { home: '/Users/nobody' });
    for (const [kind, s] of Object.entries(secrets)) expect(out, kind).not.toContain(s.slice(0, 20));
    expect(out).toContain('[redacted');
    expect(out).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(() => JSON.parse(out.trim())).not.toThrow();
  });

  it('the recorded fixtures carry no home folder', () => {
    const dir = fileURLToPath(new URL('../fixtures/traces/', import.meta.url));
    for (const f of readdirSync(dir)) expect(readFileSync(dir + f, 'utf8'), f).not.toContain(HOME);
  });
});
