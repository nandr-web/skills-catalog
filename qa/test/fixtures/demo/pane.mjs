#!/usr/bin/env node
// A fake pane program for qa demo's tests, honouring the stand-in's file contracts without the catalog. With `--as <who>`
// it is a developer's assistant: it reads a line, prints an answer, appends one activity.log line per call and one
// turns.jsonl line per ask. Without, it is the steps view: it redraws steps.json and turns Enter, p and q into control
// words (Ctrl-C is left to the window's own binding, so the tests prove that one). It never calls tmux.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse } from 'yaml';

const demo = join(process.env.QA_SANDBOX, 'demo');
const at = process.argv.indexOf('--as');
if (at > 0) assistant(process.argv[at + 1]); else stepsView();

function assistant(who) {
  const scenes = parse(readFileSync(process.env.DEMO_SCENES, 'utf8'));
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
  console.log(`${who}'s assistant (a test stand-in), HOME=${process.env.HOME} PATH=${process.env.PATH} DEMO_MCP=${process.env.DEMO_MCP ?? ''}`);
  rl.prompt();
  rl.on('line', (say) => {
    const step = scenes.steps.find((s) => s.asks.some((a) => a.who === who && a.say === say));
    const ask = step?.asks.find((a) => a.who === who && a.say === say);
    if (!ask) console.log("(this stand-in only knows the demo's steps)");
    for (const c of ask?.calls ?? []) {
      if (c.planned) { console.log(`● ${c.planned}: ${c.why}`); continue; }
      const published = c.op === 'publish' && existsSync(join('skills', c.folder, 'SKILL.md'));
      const result = c.op !== 'publish' ? `${c.op} done` : published ? `published ${c.name} as ${who}` : `no skill folder ${c.folder}`;
      console.log(`● ${c.op}  ${c.name ?? c.query ?? ''}`);
      console.log(`  │ ${result}`);
      // the log's rules: fixed result words, then the target (a search's is its match count, never the query)
      const words = c.op !== 'publish' ? 'done' : published ? 'published' : 'no skill folder';
      appendFileSync(process.env.SKILLS_ACTIVITY_LOG, `${new Date().toISOString().slice(11, 19)}  ${who.padEnd(4)}  ${c.op.padEnd(27)}  ${words.padEnd(15)}  ${c.query !== undefined ? '1 of 1 match' : c.name}\n`);
    }
    appendFileSync(join(demo, 'turns.jsonl'), JSON.stringify({ who, say, step: step?.id ?? null, ok: true, at: new Date().toISOString() }) + '\n');
    rl.prompt();
  });
}

function stepsView() {
  const mark = { seen: '✓', now: '▶', planned: '◌', missed: '✗', pending: ' ' };
  let last = '';
  setInterval(() => {
    let text;
    try { text = readFileSync(join(demo, 'steps.json'), 'utf8'); } catch { return; }
    if (text === last) return;
    last = text;
    const s = JSON.parse(text);
    const lines = s.steps.flatMap((x) => [`${mark[x.state]} ${x.id}  ${x.title}`, ...(x.state === 'now' ? [`     see: ${x.see}`] : []), ...(x.missing ?? []).map((m) => `     missing: ${m}`)]);
    process.stdout.write(`\x1b[2J\x1b[H${[s.title, ...lines, '', s.message, `HOME=${process.env.HOME}`].join('\r\n')}`);
  }, 50);
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.on('data', (b) => {
    const word = { '\r': 'next', p: 'pause', q: 'quit' }[b.toString()];
    if (word) appendFileSync(join(demo, 'control'), `${word}\n`);
  });
}
