// Scrubbing a stream-json trace before it becomes a test fixture: the real home folder becomes /Users/qa-user, the run's
// sandbox path becomes $SANDBOX, and each session id becomes a fake one (00000000-0000-4000-8000-00000000000N, in order of
// appearance), so a fixture carries no one's paths and a replayed trace can never name a real session's folders.
import { realHome } from '../safe-delete.ts';

const SESSION = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function scrubTrace(jsonl: string, o: { sandboxRoot?: string; home?: string } = {}): string {
  const home = o.home ?? realHome();
  const ids = new Map<string, string>();
  for (const line of jsonl.split('\n')) {
    try { const e = JSON.parse(line); if (typeof e?.session_id === 'string' && !ids.has(e.session_id)) ids.set(e.session_id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`); } catch { /* not a JSON line */ }
  }
  let out = jsonl;
  if (o.sandboxRoot) out = out.replace(new RegExp(escape(o.sandboxRoot), 'g'), '$$SANDBOX');
  out = out.replace(new RegExp(escape(home), 'g'), '/Users/qa-user');
  return out.replace(SESSION, (id) => ids.get(id) ?? id);
}
