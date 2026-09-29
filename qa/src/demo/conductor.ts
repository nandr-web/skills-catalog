// The demo's conductor: plays each step of the scene file into the panes, like a person typing to their assistant, and
// checks what shows. Per step: mark it now; per ask, type it into that developer's pane and wait for the assistant's
// turns.jsonl line; then look for each expected text in the panes the step names (only text that appeared during the
// step counts; in the steps pane, which redraws itself, all of it). A step is seen, planned (a planned call and nothing
// expected) or missed. Between steps it waits the pace, or for Enter; q ends. p pauses: it holds before the next ask or
// answer it would type (pausing until then), and Enter lets the rest of that step (or, between steps, the next step)
// through. Everything goes through ConductorIo, so the tests run it without tmux.
import { CLI_OPS, type Scenes, type Step } from './scenes.ts';
import type { RunState } from './steps-view.ts';

/** One turns.jsonl line: the assistant finished an ask. `step` is null for an ask it didn't know; `ok` false only on an
 *  unexpected error (a catalog refusal is an expected result). */
export type Turn = { who: string; say: string; step: number | string | null; ok: boolean; at: string };
export type StepState = 'pending' | 'now' | 'seen' | 'missed' | 'planned';
export type StepView = { id: number | string; title: string; see: string; state: StepState; missing?: string[] };
/** steps.json, which the steps view draws. `state`: starting, playing, pausing (`pausingAfter` this answer, or this step
 *  once an Enter lets it through), paused (`pausedIn` a step or between steps), waiting for Enter, or done; `keys`:
 *  whether anyone can press them (attached), so the keys line shows. */
export type StepsFile = {
  title: string; mode: 'auto' | 'step'; paused: boolean; state: RunState; pausedIn?: 'step' | 'between'; pausingAfter?: 'answer' | 'step';
  keys: boolean; message: string; steps: StepView[];
};
export type Counts = { seen: number; planned: number; missed: number };

export type ConductorIo = {
  type(who: string, text: string, instant: boolean): Promise<void>;   // into that developer's pane, then Enter
  capture(pane: string): string;                                     // a pane's text, its scrollback included
  turns(): Turn[];                                                   // turns.jsonl so far
  control(): string[];                                               // the control words since the last call
  writeSteps(s: StepsFile): void;                                    // steps.json, whole
  sleep(ms: number): Promise<void>;
};
export type ConductorOptions = {
  mode: 'auto' | 'step'; pace: number; attached: boolean; only?: string[];
  /** The stand-ins call the catalog's server (qa demo --server): the command line's steps play, and expect_server counts. */
  server?: boolean;
  /** Attached: close by itself this many seconds after the last step (as q then would), instead of waiting for q. */
  closeAfter?: number;
  turnTimeoutMs?: number; settleMs?: number; readyMs?: number;
  onMark?: (what: string) => void;   // "ready", then "step <id>" as each ends (the director times them)
};
/** A run stopped early (q or Ctrl-C before its last step): after which step (null: before any), and how many of the steps
 *  it would have played it didn't. */
export type Stopped = { after: number | string | null; not_played: number };
/** `end`: the line the steps pane ends on. */
export type Conducted = { steps: StepView[]; counts: Counts; quit: boolean; stopped: Stopped | null; end: string };

export const TITLE = 'what to look for';
/** The assistant's prompt: the conductor types only once every developer's pane shows it. */
export const PROMPT = '›';
const TICK = 50;
export const doneLine = (c: Counts) => `Done: ${c.seen} seen, ${c.planned} planned, ${c.missed} missed`;
/** Attached, the window stays until q; headless, there is nothing to press. */
export const doneMessage = (c: Counts, attached: boolean, closeAfter?: number) =>
  `${doneLine(c)}.${!attached ? '' : closeAfter === undefined ? ' Press q to close; everything is removed.' : ` It closes in ${closeAfter} s, or press q; everything is removed.`}`;
export const stoppedLine = (s: Stopped) => `stopped ${s.after === null ? 'before the first step' : `after step ${s.after}`}; ${s.not_played} not played`;
const count = (steps: StepView[]): Counts => {
  const n = (s: StepState) => steps.filter((x) => x.state === s).length;
  return { seen: n('seen'), planned: n('planned'), missed: n('missed') };
};

/** steps.json before the first step (`keys`: false for a headless run). */
export const initialSteps = (scenes: Scenes, mode: StepsFile['mode'], keys: boolean): StepsFile => ({
  title: TITLE, mode, paused: false, state: 'starting', keys, message: '', steps: scenes.steps.map((s) => ({ id: s.id, title: s.title, see: s.see, state: 'pending' })),
});

/** What a pane showed after `before` was captured: from before's last line on, less what that line already had (the
 *  prompt the next ask is typed after). */
export function since(before: string, after: string): string {
  const b = before.replace(/\s+$/, '').split('\n'), a = after.split('\n');
  const head = a[b.length - 1] ?? '', had = b[b.length - 1];
  return [head.startsWith(had) ? head.slice(had.length) : head, ...a.slice(b.length)].join('\n');
}

/** A pane's text with the assistant's wrapped lines joined: a line that goes on under the gutter ("  │ ") is one line. */
export const joined = (text: string) => text.replace(/ *\n {2}│ /g, ' ');

export async function conduct(scenes: Scenes, io: ConductorIo, o: ConductorOptions): Promise<Conducted> {
  const view = initialSteps(scenes, o.mode, o.attached);
  const timeout = o.turnTimeoutMs ?? 30_000, settle = o.settleMs ?? 3000;
  let quit = false, done = false, ready = false, nexts = 0, waiting: 'no' | 'enter' | 'pace' = 'no';
  // holding: where a pause really stops it (a wait, a hold, or before the start, when nothing is under way), and
  // where: in a step or between steps; pass: an Enter while paused lets the rest of the step through.
  let holding = false, where: 'step' | 'between' = 'between', pass = false;
  // The steps pane says the state; the message is left for the end.
  const render = () => {
    const held = holding || !ready;
    view.state = done ? 'done' : view.paused ? (held ? 'paused' : 'pausing') : !ready ? 'starting' : waiting === 'enter' ? 'waiting' : 'playing';
    if (view.state === 'paused') view.pausedIn = ready ? where : 'between'; else delete view.pausedIn;
    if (view.state === 'pausing') view.pausingAfter = pass ? 'step' : 'answer'; else delete view.pausingAfter;
    io.writeSteps(view);
  };
  const poll = () => {
    for (const w of io.control()) {
      if (w === 'quit') quit = true;
      else if (w === 'next') nexts++;
      else if (w === 'pause' && !done) {
        view.paused = !view.paused;
        if (view.paused) nexts = 0;   // an Enter from before the pause never lets an ask through
        render();
      }
    }
    return quit;
  };
  // Between steps: `seconds` (not counting a pause), or until Enter; for Enter only in step mode.
  const wait = async (seconds: number, forEnter: boolean) => {
    waiting = forEnter ? 'enter' : 'pace';
    holding = true;
    where = 'between';
    render();
    for (let waited = 0; !poll(); ) {
      if (nexts) { nexts--; pass = view.paused; break; }
      if (!forEnter && !view.paused && waited >= seconds * 1000) break;
      await io.sleep(TICK);
      if (!view.paused) waited += TICK;
    }
    waiting = 'no';
    holding = false;
  };
  // Before typing an ask or an answer: while paused, hold until p again, or Enter lets the rest of this step through.
  const hold = async () => {
    if (poll() || !view.paused || pass) return;
    holding = true;
    where = 'step';
    render();
    while (!poll() && view.paused) {
      if (nexts) { nexts--; pass = true; break; }
      await io.sleep(TICK);
    }
    holding = false;
    if (view.paused && !quit) render();   // let through by Enter: pausing again after the step (p again already drew playing)
  };
  // The ask's turn; meanwhile each `then` is typed once the pane shows its `after` (the person's y at a question). If
  // the turn comes first (the question never asked, e.g. the step is planned here), the rest is skipped.
  const answer = async (who: string, seen: number, then: { type: string; after: string }[], from: string, instant: boolean): Promise<Turn | undefined> => {
    let next = 0;
    for (let waited = 0; ; waited += TICK) {
      const turn = io.turns().slice(seen).find((t) => t.who === who);
      if (turn || waited >= timeout || poll()) return turn;
      if (next < then.length && joined(since(from, io.capture(who))).includes(then[next]!.after)) {
        await hold();
        if (quit) return undefined;
        await io.type(who, then[next++]!.type, instant);
      }
      await io.sleep(TICK);
    }
  };
  const expects = (step: Step) => {
    const all: Record<string, string[]> = { ...step.expect };
    if (o.server) for (const [p, l] of Object.entries(step.expect_server ?? {})) all[p] = [...(all[p] ?? []), ...l];
    return all;
  };
  const play = async (step: Step, instant: boolean): Promise<string[]> => {
    const missing: string[] = [];
    const expected = expects(step);
    const panes = Object.keys(expected);
    const before = Object.fromEntries(panes.filter((p) => p !== 'steps').map((p) => [p, io.capture(p)]));
    for (const ask of step.asks) {
      await hold();
      if (quit) return missing;
      const seen = io.turns().length;
      const from = io.capture(ask.who);
      await io.type(ask.who, ask.say, instant);
      const turn = await answer(ask.who, seen, ask.then ?? [], from, instant);
      if (quit) return missing;
      if (!turn) { missing.push(`${ask.who} didn't answer "${ask.say}" within ${timeout / 1000} s`); break; }
      if (turn.step === null) missing.push(`${ask.who}'s assistant didn't know "${ask.say}"`);
      else if (!turn.ok) missing.push(`${ask.who}'s assistant hit an unexpected error`);
    }
    let left = panes.flatMap((p) => expected[p]!.map((text) => ({ p, text })));
    for (let waited = 0; left.length; waited += TICK) {
      const shown = Object.fromEntries(panes.map((p) => [p, p === 'steps' ? io.capture(p) : since(before[p], io.capture(p))]));
      left = left.filter(({ p, text }) => !joined(shown[p]).includes(text));
      if (!left.length || waited >= settle || poll()) break;
      await io.sleep(TICK);
    }
    return [...missing, ...left.map(({ p, text }) => `${p}: ${text}`)];
  };

  io.writeSteps(view);
  for (let waited = 0; waited < (o.readyMs ?? 30_000) && !scenes.developers.every((d) => io.capture(d.id).includes(PROMPT)) && !poll(); waited += TICK) await io.sleep(TICK);
  ready = true;
  // Paused while starting: it holds before the first step (step by step, the wait for Enter holds there anyway).
  if (view.paused && o.mode === 'auto' && !quit) await wait(0, false);
  o.onMark?.('ready');
  const only = o.only?.map(String);
  const last = only ? Math.max(...scenes.steps.map((s, i) => (only.includes(String(s.id)) ? i : -1))) : scenes.steps.length - 1;
  for (let i = 0; i <= last && !quit; i++) {
    const step = scenes.steps[i], v = view.steps[i];
    const fast = !!only && !only.includes(String(step.id));   // a step before the chosen ones: at once, to set up
    if (o.mode === 'step' && !fast) { await wait(0, true); if (quit) break; }
    v.state = 'now';
    render();
    const missing = await play(step, fast || o.pace === 0);
    if (quit) { v.state = 'pending'; break; }
    // Planned: a planned call, or, without the server, a command-line op (it shows as planned there).
    const planned = step.asks.some((a) => a.calls.some((c) => 'planned' in c || (!o.server && CLI_OPS.includes(c.op))));
    const expected = Object.values(expects(step)).some((l) => l.length);
    v.state = missing.length ? 'missed' : planned && !expected ? 'planned' : 'seen';
    if (missing.length) v.missing = missing;
    o.onMark?.(`step ${step.id}`);
    render();   // an Enter's pass still says "pausing after this step" as the step ends
    pass = false;   // and never carries into the next step
    if (o.mode === 'auto' && !fast && i < last) await wait(o.pace, false);
  }
  const counts = count(view.steps);
  done = true;
  // Stopped: q before every step it would play had played (q after the last step is the end).
  const toPlay = view.steps.slice(0, last + 1), left = toPlay.filter((s) => s.state === 'pending').length;
  const stopped: Stopped | null = quit && left ? { after: toPlay.findLast((s) => s.state !== 'pending')?.id ?? null, not_played: left } : null;
  const end = stopped ? stoppedLine(stopped).replace(/^s/, 'S') : doneLine(counts);
  view.message = stopped ? `${end}. Everything is removed.` : doneMessage(counts, o.attached, o.closeAfter);
  render();
  if (!quit && o.attached) for (let waited = 0; !poll() && !(o.closeAfter !== undefined && waited >= o.closeAfter * 1000); waited += TICK) await io.sleep(TICK);
  return { steps: view.steps, counts, quit, stopped, end };
}
