#!/usr/bin/env node
// The steps pane of the one-click demo: redraws from $QA_SANDBOX/demo/steps.json when it changes,
// and turns keys into words for the conductor, appended to $QA_SANDBOX/demo/control. Render and key mapping are pure.
//   node src/demo/steps-view.ts
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GREEN = '\x1b[32m', BOLD_GREEN = '\x1b[1;32m', ORANGE = '\x1b[38;5;208m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const paint = (colour: string, s: string) => `${colour}${s}${RESET}`;

export type StepView = { id: number; title: string; see: string; state: 'pending' | 'now' | 'seen' | 'missed' | 'planned'; missing?: string[] };
export type StepsState = { title: string; mode: 'auto' | 'step'; paused: boolean; message: string; steps: StepView[] };
export type Command = 'next' | 'pause' | 'quit';

export const KEYS_LINE = 'Enter next · p pause · q quit';
const MARK = { seen: '✓', now: '▶', planned: '◌', missed: '✗', pending: ' ' } as const;
const COLOUR = { now: BOLD_GREEN, planned: DIM, missed: ORANGE } as Record<StepView['state'], string>;
const INDENT = '     ';

/** Words to lines of at most `width`: the first line after `first`, the rest after `rest`; a longer word is cut. */
function wrap(text: string, width: number, first = '', rest = INDENT): string[] {
  const lines: string[] = [];
  let line = first, fresh = true;
  for (let word of text.split(' ')) {
    const room = () => width - line.length - (fresh ? 0 : 1);
    if (!fresh && word.length > room()) { lines.push(line); line = rest; fresh = true; }
    while (word.length > room() && room() > 0) { lines.push(line + (fresh ? '' : ' ') + word.slice(0, room())); word = word.slice(room()); line = rest; fresh = true; }
    line += (fresh ? '' : ' ') + word;
    fresh = false;
  }
  lines.push(line);
  return lines;
}

/** A see text that says the step isn't played yet (planned, next, not in this demo) is shown as it is; any other is
 *  what to look for. */
const seeLine = (see: string) => (/^(planned|next in this demo|not in this demo)\b/.test(see) ? see : `see: ${see}`);

/** The pane's text for a steps.json (null: the conductor hasn't written one yet). */
export function renderSteps(state: StepsState | null, o: { width?: number } = {}): string {
  const width = o.width ?? Infinity;
  const block = (text: string, colour?: string, first = '', rest = INDENT) => wrap(text, width, first, rest).map((l) => (colour ? paint(colour, l) : l));
  if (!state) return [...block('waiting for the demo to start…', DIM, '', ''), '', paint(DIM, KEYS_LINE)].join('\n');
  const out = [...block(state.title, BOLD, '', ''), ''];
  for (const s of state.steps) {
    const head = wrap(`${MARK[s.state]} ${s.id}  ${s.title}`, width);
    if (s.state === 'seen') out.push(`${paint(GREEN, MARK.seen)}${head[0]!.slice(1)}`, ...head.slice(1));
    else if (s.state === 'pending') out.push(...head);
    else out.push(...head.map((l) => paint(COLOUR[s.state], l)));
    if (s.state === 'now') out.push(...block(seeLine(s.see), undefined, INDENT));
    if (s.state === 'pending' || s.state === 'planned') out.push(...block(seeLine(s.see), DIM, INDENT));
    if (s.state === 'missed') for (const m of s.missing ?? []) out.push(...block(`missing: ${m}`, ORANGE, INDENT));
  }
  out.push('', ...block(`${MARK.seen} = the demo checked it too`, DIM, '', ''));
  if (state.message) out.push(...block(state.message, undefined, '', ''));
  if (state.paused) out.push(...block('paused: p to carry on', ORANGE, '', ''));
  else if (state.mode === 'step') out.push(...block('one step at a time: Enter for the next', DIM, '', ''));
  out.push(...block(KEYS_LINE, DIM, '', ''));
  return out.join('\n');
}

/** One key to the conductor's word: Enter → next, p → pause, q or Ctrl-C → quit. */
export function keyCommand(key: string): Command | null {
  if (key === '\r' || key === '\n') return 'next';
  if (key === 'p' || key === 'P') return 'pause';
  if (key === 'q' || key === 'Q' || key === '\x03') return 'quit';
  return null;
}

/** A chunk of input as keys: an escape sequence (an arrow key) is one key. */
export function keysOf(chunk: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const m = chunk[i] === '\x1b' ? /^\x1b(\[[0-?]*[ -/]*[@-~]|.)?/.exec(chunk.slice(i))! : null;
    keys.push(m ? m[0] : chunk[i]!);
    if (m) i += m[0].length - 1;
  }
  return keys;
}

async function main(): Promise<number> {
  const root = process.env.QA_SANDBOX;
  if (!root) { process.stderr.write('needs QA_SANDBOX, which the demo sets (npm run demo)\n'); return 3; }
  const demo = join(root, 'demo');   // the director makes it; this only adds to control
  const stepsFile = join(demo, 'steps.json'), control = join(demo, 'control');
  let last: string | null | undefined, lastWidth = 0;
  const draw = () => {
    let raw: string | null = null;
    try { raw = readFileSync(stepsFile, 'utf8'); } catch { /* not written yet */ }
    const width = process.stdout.columns || 48;
    if (raw === last && width === lastWidth) return;
    let state: StepsState | null = null;
    if (raw !== null) { try { state = JSON.parse(raw); } catch { return; } }
    last = raw;
    lastWidth = width;
    process.stdout.write('\x1b[H\x1b[2J' + renderSteps(state, { width }));
  };
  const send = (c: Command) => appendFileSync(control, `${c}\n`);
  process.stdout.write('\x1b[?25l');   // no cursor in this pane
  draw();
  const timer = setInterval(draw, 150);
  process.on('SIGINT', () => send('quit'));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (b) => { for (const k of keysOf(b.toString())) { const c = keyCommand(k); if (c) send(c); } });
  // In the demo's pane the input never ends; piped input (a test) does.
  await new Promise((ok) => process.stdin.on('end', ok));
  clearInterval(timer);
  process.stdout.write('\x1b[?25h');
  return 0;
}

if (import.meta.main) process.exitCode = await main();
