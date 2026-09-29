// Scrubbing a stream-json trace before it becomes a test fixture: the real home folder becomes /Users/qa-user, the run's
// sandbox path becomes $SANDBOX, each session id becomes a fake one (00000000-0000-4000-8000-00000000000N, in order of
// appearance), and secrets in the usual formats become "[redacted <kind>]", so a fixture carries no one's paths or keys
// and a replayed trace can never name a real session's folders.
import { realHome } from '../safe-delete.ts';

const SESSION = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** AWS's documented example key: no secret, and the goldens plant it on purpose. */
const EXAMPLE_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRETS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['aws key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['github token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/g],
];

export function scrubTrace(jsonl: string, o: { sandboxRoot?: string; home?: string } = {}): string {
  const home = o.home ?? realHome();
  const ids = new Map<string, string>();
  for (const line of jsonl.split('\n')) {
    try { const e = JSON.parse(line); if (typeof e?.session_id === 'string' && !ids.has(e.session_id)) ids.set(e.session_id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`); } catch { /* not a JSON line */ }
  }
  let out = jsonl;
  for (const [kind, re] of SECRETS) out = out.replace(re, (m) => (m === EXAMPLE_AWS_KEY ? m : `[redacted ${kind}]`));
  if (o.sandboxRoot) out = out.replace(new RegExp(escape(o.sandboxRoot), 'g'), '$$SANDBOX');
  out = out.replace(new RegExp(escape(home), 'g'), '/Users/qa-user');
  return out.replace(SESSION, (id) => ids.get(id) ?? id);
}
