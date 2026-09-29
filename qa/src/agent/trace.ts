// A headless Claude Code run's stream-json trace (`--output-format stream-json --verbose`): the session, each tool call and
// result in order, and the final result. The scorer reads only this and the sandbox, never the system's own report.
export type Step =
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; isError: boolean; text: string }
  | { kind: 'text'; text: string };

export type Trace = {
  sessions: string[];
  init?: { model: string; permissionMode: string; tools: string[] };
  steps: Step[];
  result?: { isError: boolean; subtype?: string; text: string; durationMs: number; costUsd: number; numTurns: number; permissionDenials: unknown[] };
};

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '')).join('')
      : '';

export function parseTrace(jsonl: string): Trace {
  const t: Trace = { sessions: [], steps: [] };
  for (const line of jsonl.split('\n')) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.session_id && !t.sessions.includes(e.session_id)) t.sessions.push(e.session_id);
    if (e?.type === 'system' && e.subtype === 'init') t.init = { model: e.model, permissionMode: e.permissionMode, tools: e.tools ?? [] };
    else if (e?.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use') t.steps.push({ kind: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
        else if (c.type === 'text') t.steps.push({ kind: 'text', text: c.text ?? '' });
      }
    } else if (e?.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) if (c.type === 'tool_result') t.steps.push({ kind: 'tool_result', id: c.tool_use_id, isError: !!c.is_error, text: textOf(c.content) });
    } else if (e?.type === 'result') {
      t.result = { isError: !!e.is_error, subtype: e.subtype, text: e.result ?? '', durationMs: e.duration_ms ?? 0, costUsd: e.total_cost_usd ?? 0, numTurns: e.num_turns ?? 0, permissionDenials: e.permission_denials ?? [] };
    }
  }
  return t;
}
