// `skills-catalog hook session-start --setup-id <id>` (contract §3 "Telling the person about a held update"; setup build
// notes §10): the command setup's session-start hook runs. Not an operation: a process command outside the registry,
// never pre-allowed or offered as a tool. It reads its input (capped, ignored: it never opens transcript_path or anything
// it names), says so when setup's MCP server entry has gone from .claude.json, syncs (an update run, given up after 2
// seconds), and when an update waits for the person's yes prints one JSON object: a systemMessage for the person and
// additionalContext for the model, each only names, versions, counts and fixed words. Nothing waits: nothing printed. It
// always exits 0, so it never breaks a session; an error is logged by perform, never shown, except a damaged lock or
// config file, which the person should know about.

import { CatalogError, renderError, type Words } from '@skills-catalog/core';
import { jsonEqual } from '../machine/json-equal.ts';
import { readJsonFile } from '../machine/json-file.ts';
import type { UpdateView } from '../machine/installer.ts';
import { CLAUDE_JSON_CAP } from '../machine/setup-plan.ts';
import { RECORD_CAP } from '../machine/setup-places.ts';
import { contextFor, perform } from '../operations.ts';
import { settingsFrom } from '../settings.ts';
import { join } from 'node:path';

export type HookIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: AsyncIterable<Uint8Array | string>;
  stdout: (text: string) => void;
  /** How long the sync may take (2 s; tests shorten it). */
  budgetMs?: number;
};

export const STDIN_CAP = 64 * 1024;
const BUDGET_MS = 2000;
const MAX_NAMED = 10;
// The holds that wait for the person's yes; a pinned skill asks nothing.
const WAITS = new Set(['held_flagged', 'held_notify', 'held_other_catalog']);

/** Reads and drops the hook's input, at most STDIN_CAP bytes, giving up after `ms`. */
async function drain(stdin: HookIo['stdin'], ms: number): Promise<void> {
  let size = 0;
  const read = (async () => {
    for await (const chunk of stdin) {
      size += chunk.length;
      if (size > STDIN_CAP) return;
    }
  })();
  await Promise.race([read.catch(() => {}), new Promise((ok) => setTimeout(ok, ms).unref())]);
}

/** The words for "name v1 → v2", cut after MAX_NAMED with "and N more" (each under 10,000 characters by construction). */
function itemsOf(items: UpdateView['items']): string {
  const shown = items.slice(0, MAX_NAMED).map((i) => `${i.name} v${i.from} → v${i.to}`);
  return items.length > MAX_NAMED ? `${shown.join(', ')} and ${items.length - MAX_NAMED} more` : shown.join(', ');
}

/** Whether setup's recorded MCP server entry (for this setup id) has gone from .claude.json: the path to name, or none. */
function entryMissing(home: string, assistantHome: string, id: string): string | undefined {
  const r = readJsonFile(join(home, 'setup-record.json'), RECORD_CAP, { forWrite: false });
  if (!('value' in r) || r.value['setup_id'] !== id) return undefined;
  const entries = Array.isArray(r.value['entries']) ? (r.value['entries'] as { kind?: unknown; value?: unknown }[]) : [];
  const recorded = entries.find((e) => e.kind === 'mcp_entry');
  if (!recorded) return undefined;
  const path = join(assistantHome, '.claude.json');
  const f = readJsonFile(path, CLAUDE_JSON_CAP, { forWrite: false });
  if (!('value' in f)) return path;
  const servers = f.value['mcpServers'];
  const entry = servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as Record<string, unknown>)['skills-catalog'] : undefined;
  return jsonEqual(entry, recorded.value) ? undefined : path;
}

export async function runHook(argv: readonly string[], s: Words, io: HookIo): Promise<number> {
  const [event, flag, id] = argv;
  if (event !== 'session-start' || flag !== '--setup-id' || !/^[0-9a-f]{32}$/.test(id ?? '') || argv.length !== 3) return 0;
  await drain(io.stdin, 500);
  const messages: { person: string[]; context: string[] } = { person: [], context: [] };
  try {
    const settings = settingsFrom(io.env, io.cwd);
    try {
      const missing = entryMissing(settings.home, settings.assistantHome, id!);
      if (missing) messages.person.push(s.format(s.setup.hook_entry_missing, { path: missing }));
    } catch {
      // A record or file that can't be read proves nothing missing: say nothing.
    }
    const { ctx, close } = contextFor(settings, s, 'cli');
    try {
      const timeout = new Promise<'late'>((ok) => setTimeout(() => ok('late'), io.budgetMs ?? BUDGET_MS).unref());
      const a = await Promise.race([perform(ctx, 'update_installed_skills', 'hook session-start', {}), timeout]);
      if (a !== 'late') {
        if (a.isError && a.error?.code === 'invalid_local_file') messages.person.push(renderError(s, a.error));
        const view = a.view as UpdateView | undefined;
        const waiting = view?.kind === 'update' ? view.items.filter((i) => WAITS.has(i.kind)) : [];
        if (waiting.length) {
          const fields = { n: waiting.length, items: itemsOf(waiting) };
          messages.person.push(s.format(s.word('update.held_hook_person'), fields));
          messages.context.push(s.format(s.word('update.held_hook_context'), fields));
        }
      }
    } finally {
      close();
    }
  } catch (e) {
    if (!(e instanceof CatalogError)) return 0;
    if (e.code === 'invalid_local_file') messages.person.push(renderError(s, e));
  }
  if (!messages.person.length && !messages.context.length) return 0;
  const out: Record<string, unknown> = {};
  if (messages.person.length) out['systemMessage'] = messages.person.join('\n');
  if (messages.context.length) out['hookSpecificOutput'] = { hookEventName: 'SessionStart', additionalContext: messages.context.join('\n') };
  io.stdout(JSON.stringify(out) + '\n');
  return 0;
}
