// `skills-catalog setup` (contract §6; setup build notes §8, §9; the owner's "a welcome, intuitive, (colorful) UX that
// asks you if you want auto-updates on (with a default of yes in case someone wants to run fast / unattended)"). One
// question table drives the wizard, the flags, `--config <file>`, `--help` and the no-terminal output, so they can't
// drift. Answers come from flags, then the --config file (a flag and the file answering differently is refused), then the
// person at a terminal, or every default with --yes. With no terminal and questions left, nothing changes and the
// questions are printed with their flags (exit 3). Then the plan (each file and what it gets), "Go ahead? (Y/n)" at a
// terminal, the run (machine/setup-run.ts) and the summary. Colour only at a terminal and never alone: every line says
// what it means in words. Exit 0 done, 1 refused (nothing changed), 3 needs answers.

import { randomBytes } from 'node:crypto';
import { realpathSync, statfsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ACTOR, CatalogError, openCatalog, renderError, shellQuote, Words } from '@skills-catalog/core';
import { readJsonFile } from '../machine/json-file.ts';
import { CONFIG_KEYS, configWhy, isCatalogAddress, readConfig, type Config } from '../machine/lock.ts';
import { permissiveMode } from '../machine/permissive.ts';
import { allowRules, mcpEntry } from '../machine/setup-entries.ts';
import { planSetup, type PlanInput, type SetupPlan } from '../machine/setup-plan.ts';
import { runSetup, type CommandOutcome } from '../machine/setup-run.ts';
import { painter, type Paint } from '../person/terminal.ts';
import { machineDeveloper, settingsFrom, type Settings } from '../settings.ts';
import { cliWords } from './words.ts';

export type SetupIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  /** stdin and stdout are both terminals: the person can answer. */
  tty: boolean;
  color: boolean;
  ask: (question: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Seams for tests: the install setup points Claude Code at, the user, the clock and the new setup id. */
  install?: { node: string; script: string; temporaryRoots: readonly string[] };
  uid?: number;
  now?: () => number;
  newId?: string;
};

/** The file the package's bin names (client/package.json: ./src/cli.ts), by its real path. */
export const SCRIPT = fileURLToPath(new URL('../cli.ts', import.meta.url));
const DEMO = ['dev1', 'dev2'];
const POLICY_NO = 'notify';

type Kind = 'yesno' | 'text' | 'switch';
type Ctx = { settings: Settings; existing: Config; env: Record<string, string | undefined>; cwd: string };
/** One question: its config key, flag, how a typed answer becomes a value, its default, and the value's config entry. */
export type Question = {
  id: 'auto_update' | 'catalog' | 'for' | 'me' | 'demo_developers' | 'terminal_command';
  flag: string;
  kind: Kind;
  /** The config.json key the answer writes. */
  key: string;
  parse(text: string, c: Ctx): unknown;
  /** The default, as a value; undefined when there's none (a name, with no login to offer). */
  fallback(c: Ctx): unknown;
  /** The answer as the --config file gives it, if it does. */
  fromConfig(config: Config): unknown;
  /** How a value reads at the prompt and in the no-terminal list. */
  show(v: unknown, c: Ctx): string;
};

const bad = (field: string, why: string, extra: Record<string, unknown> = {}) => new CatalogError('invalid_request', { field, why, ...extra });
const yesNo = (flag: string) => (t: string) => {
  const v = t.trim().toLowerCase();
  if (['y', 'yes'].includes(v)) return true;
  if (['n', 'no'].includes(v)) return false;
  throw bad(`--${flag}`, 'not_one_of', { allowed: 'yes, no' });
};
const defaultCatalog = (c: Ctx) => pathToFileURL(join(c.settings.home, 'catalog')).href;
const shownCatalog = (v: unknown) => (typeof v === 'string' && v.startsWith('file:') ? fileURLToPath(v) : String(v));

export const QUESTIONS: readonly Question[] = [
  {
    id: 'auto_update', flag: 'auto-update', kind: 'yesno', key: 'update_policy',
    parse: (t) => yesNo('auto-update')(t),
    fallback: (c) => (c.existing.update_policy === undefined ? true : c.existing.update_policy === 'auto'),
    fromConfig: (k) => (k.update_policy === undefined ? undefined : k.update_policy === 'auto'),
    show: (v) => (v ? 'yes' : 'no'),
  },
  {
    id: 'catalog', flag: 'catalog', kind: 'text', key: 'catalog',
    // A folder (made absolute where setup runs) or a hosted catalog's address.
    parse: (t, c) => {
      const v = t.trim();
      if (!v) throw bad('--catalog', 'empty');
      const url = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : pathToFileURL(resolve(c.cwd, v.replace(/^~(?=$|\/)/, c.env['HOME'] ?? homedir()))).href;
      if (!isCatalogAddress(url)) throw bad('--catalog', 'not_a_catalog_url');
      return url;
    },
    fallback: (c) => (typeof c.existing['catalog'] === 'string' ? c.existing['catalog'] : defaultCatalog(c)),
    fromConfig: (k) => k['catalog'],
    show: (v) => shownCatalog(v),
  },
  {
    id: 'for', flag: 'for', kind: 'text', key: 'targets',
    parse: (t) => {
      if (t.trim() !== 'claude-code') throw bad('--for', 'not_one_of', { allowed: 'claude-code' });
      return 'claude-code';
    },
    fallback: () => 'claude-code',
    fromConfig: (k) => (Array.isArray(k['targets']) ? k['targets'][0] : undefined),
    show: (v) => String(v),
  },
  {
    id: 'me', flag: 'me', kind: 'text', key: 'me',
    parse: (t) => {
      const v = t.trim();
      if (!ACTOR.test(v)) throw bad('--me', 'not_a_developer_name');
      return v;
    },
    // A name setup saved before, else the login (the same name a skill published before setup was published as).
    fallback: (c) => (typeof c.existing['me'] === 'string' ? c.existing['me'] : machineDeveloper(c.env)),
    fromConfig: (k) => k['me'],
    show: (v) => String(v),
  },
  {
    id: 'demo_developers', flag: 'demo-developers', kind: 'switch', key: 'demo_developers',
    parse: (t) => yesNo('demo-developers')(t),
    fallback: (c) => Array.isArray(c.existing['demo_developers']) && c.existing['demo_developers'].length > 0,
    fromConfig: (k) => (k['demo_developers'] === undefined ? undefined : Array.isArray(k['demo_developers']) && k['demo_developers'].length > 0),
    show: (v) => (v ? 'yes' : 'no'),
  },
  {
    id: 'terminal_command', flag: 'terminal-command', kind: 'yesno', key: 'terminal_command',
    parse: (t) => yesNo('terminal-command')(t),
    fallback: (c) => c.existing['terminal_command'] !== false,
    fromConfig: (k) => k['terminal_command'],
    show: (v) => (v ? 'yes' : 'no'),
  },
];

/** The config keys setup never asks about (§6): the --config file may give them, as config.json takes them. */
export const NON_QUESTION_KEYS: readonly string[] = Object.keys(CONFIG_KEYS).filter((k) => !QUESTIONS.some((q) => q.key === k));
const OWN_FLAGS = { yes: { type: 'boolean' }, config: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'print-mcp-entry': { type: 'boolean' }, help: { type: 'boolean' } } as const;

/** The setup doc an assistant can follow to run setup unattended (skill-setup-by-agent; docs/setup.md, written by
 *  `npm run setup-doc` in client/ and kept equal by a test): the words' doc and assistant note, then each question with
 *  the flag that answers it and its default, from the table. */
export function setupDoc(s: Words): string {
  const q = s.setup.questions as { ask: string; default: string; flag: string }[];
  const fill = { default_catalog: '~/.skills-catalog/catalog', me_default: 'your login, made into a name', command_folder: '~/.local/bin' };
  const rows = q.map((x) => `| ${s.format(x.ask, fill).replaceAll('|', '\\|')} | \`${x.flag.replaceAll('|', '\\|')}\` | ${s.format(x.default, fill)} |`);
  return [
    '<!-- Written by `npm run setup-doc` in client/ from the words file and setup\'s question table. Don\'t edit by hand. -->',
    '',
    s.setup.doc.trimEnd(),
    s.setup.doc_assistant_note.trimEnd(),
    '',
    '## The questions, and the flag that answers each',
    '',
    '| Question | Flag | Default |',
    '|---|---|---|',
    ...rows,
    '',
    `Also: \`--config <file>\` (a JSON file with config.json's keys, the same answers as the flags), \`--dry-run\` (the plan, nothing changed), \`--print-mcp-entry\` (the entry for another MCP client). Exit 0 done, 1 refused (nothing changed), 3 needs answers. Undo with \`${s.cli} teardown\`.`,
    '',
  ].join('\n');
}

/** Every flag setup takes (cli/process.ts lists them for the words' check; a test keeps the two equal). */
export const SETUP_FLAGS: readonly string[] = [...Object.keys(OWN_FLAGS), ...QUESTIONS.flatMap((q) => (q.kind === 'switch' ? [q.flag, `no-${q.flag}`] : [q.flag]))];

/** The usage line and each question's flag, from the table. */
export function setupHelp(s: Words): string {
  const q = s.setup.questions as { ask: string; default: string; flag: string }[];
  return [`${s.cli} setup [--yes] [--config <file>] [--dry-run] [--print-mcp-entry]`, ...q.map((x) => `  ${x.flag}`)].join('\n') + '\n';
}

type Answered = Partial<Record<Question['id'], unknown>>;

/** The flags' answers, and the run's own switches; an unknown flag is a usage error. */
function readFlags(argv: readonly string[], c: Ctx) {
  const options: Record<string, { type: 'string' | 'boolean' }> = { ...OWN_FLAGS };
  for (const q of QUESTIONS) options[q.flag] = { type: q.kind === 'switch' ? 'boolean' : 'string' };
  const { values, positionals } = parseArgs({ args: [...argv], options, strict: true, allowPositionals: true, allowNegative: true });
  if (positionals.length) throw new TypeError('usage');
  const answers: Answered = {};
  for (const q of QUESTIONS) {
    const v = values[q.flag];
    if (v === undefined) continue;
    answers[q.id] = q.kind === 'switch' ? v : q.parse(String(v), c);
  }
  return { answers, values: values as Record<string, string | boolean | undefined> };
}

/** The --config file: read as setup reads any settings file (1 MiB, never through a link, a JSON object), with only
 *  config.json's keys, each as config.json takes it; accept_flagged_updates can't be turned on through setup. */
function readConfigFile(path: string, cwd: string): Config {
  const full = resolve(cwd, path);
  const f = readJsonFile(full, 1024 * 1024, { forWrite: false });
  if ('absent' in f) throw bad('--config', 'not_found');
  if ('why' in f) throw new CatalogError('invalid_local_file', { file: '--config', why: f.why === 'not_json' ? 'not_json' : 'wrong_shape', path: full });
  const value = f.value;
  const refused = configWhy(value);
  if (refused) {
    const r = typeof refused === 'string' ? { why: refused, key: '--config' } : refused;
    throw bad(r.key, Object.hasOwn(CONFIG_KEYS, r.key) ? r.why : 'unknown_field');
  }
  if (value['accept_flagged_updates'] === true) throw bad('accept_flagged_updates', 'not_through_setup');
  return value as Config;
}

/** config.json after the answers: what was there, the file's other settings, then each answer as its key. */
function configFrom(base: Config, file: Config, a: Answered, c: Ctx): Config {
  const out: Config = { ...base, ...file };
  if (a.auto_update !== undefined) out.update_policy = a.auto_update ? 'auto' : POLICY_NO;
  if (a.catalog !== undefined) {
    if (a.catalog === defaultCatalog(c)) delete out['catalog'];
    else out['catalog'] = a.catalog;
  }
  if (a.me !== undefined) out['me'] = a.me;
  if (a.demo_developers === true) out['demo_developers'] = Array.isArray(file['demo_developers']) && file['demo_developers'].length ? file['demo_developers'] : Array.isArray(base['demo_developers']) && base['demo_developers'].length ? base['demo_developers'] : DEMO;
  if (a.demo_developers === false) delete out['demo_developers'];
  if (a.terminal_command !== undefined) out['terminal_command'] = a.terminal_command;
  return out;
}

// ---------- the network or synced folder check (F0: a folder catalog is one machine only) ----------

// statfs's type numbers on Linux for NFS, SMB/CIFS and FUSE (sshfs, rclone and other mounts).
const NETWORK_MAGIC = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546]);
const SYNCED = ['/Library/CloudStorage/', '/Library/Mobile Documents/', '/Dropbox/', '/OneDrive', '/Google Drive/', '/iCloud Drive/', '/Box/', '/Sync/'];

/** Whether a folder catalog's place looks like a network or a synced folder (the nearest folder that exists is checked). */
export function sharedFolderKind(path: string, statfs: (p: string) => { type: number | bigint } = statfsSync): 'network' | 'synced' | undefined {
  const at = `${path}${sep}`;
  if (SYNCED.some((m) => at.includes(m))) return 'synced';
  for (let p = path; ; p = dirname(p)) {
    try {
      const t = Number(statfs(p).type);
      return NETWORK_MAGIC.has(t) ? 'network' : undefined;
    } catch {
      if (dirname(p) === p) return undefined;
    }
  }
}

// ---------- the command ----------

export async function runSetupCommand(argv: readonly string[], io: SetupIo): Promise<number> {
  const s = cliWords(Words.load());
  const paint = painter(io.color);
  const err = (e: unknown) => {
    if (!(e instanceof CatalogError)) throw e;
    io.stderr(renderError(s, e) + '\n');
    return 1;
  };
  const settings = settingsFrom(io.env, io.cwd);
  let existing: Config;
  try {
    existing = readConfig(settings.home);
  } catch (e) {
    return err(e);
  }
  const c: Ctx = { settings, existing, env: io.env, cwd: io.cwd };

  let flags: ReturnType<typeof readFlags>;
  try {
    flags = readFlags(argv, c);
  } catch (e) {
    if (e instanceof CatalogError) return err(e);
    io.stderr(setupHelp(s));
    return 1;
  }
  const { values } = flags;
  if (values['help']) {
    io.stdout(setupHelp(s));
    return 0;
  }

  // The --config file's answers, checked against the flags'.
  let file: Config = {};
  const answers: Answered = { ...flags.answers };
  try {
    if (typeof values['config'] === 'string') {
      file = readConfigFile(values['config'], io.cwd);
      for (const q of QUESTIONS) {
        const given = q.fromConfig(file);
        if (given === undefined) continue;
        const v = q.id === 'catalog' ? q.parse(String(given), c) : q.id === 'me' ? q.parse(String(given), c) : given;
        if (answers[q.id] !== undefined && answers[q.id] !== v) throw bad(`--${q.flag}`, 'contradicting_flags');
        answers[q.id] = v;
      }
    }
  } catch (e) {
    return err(e);
  }

  const words = s.setup.questions as { ask: string; default: string; flag: string }[];
  const fill = { default_catalog: shownCatalog(defaultCatalog(c)), me_default: '', command_folder: join(settings.assistantHome, '.local', 'bin') };
  const askText = (i: number) => s.format(words[i]!.ask, fill);
  const unanswered = () => QUESTIONS.filter((q) => answers[q.id] === undefined);
  const yes = values['yes'] === true;
  const dryRun = values['dry-run'] === true;

  if (!yes && !io.tty && unanswered().length && !dryRun && !values['print-mcp-entry']) {
    const list = unanswered().map((q) => {
      const d = q.fallback(c);
      return `- ${askText(QUESTIONS.indexOf(q))} (${words[QUESTIONS.indexOf(q)]!.flag}${d === undefined ? '' : `; default: ${q.show(d, c)}`})`;
    });
    io.stdout(s.format(s.setup.no_terminal, { n: list.length, questions: list.join('\n') }).trimEnd() + '\n');
    return 3;
  }

  if (!yes && io.tty && unanswered().length && !dryRun && !values['print-mcp-entry']) {
    io.stdout(paint('bold', s.format(s.setup.welcome, { n: unanswered().length })) + '\n\n');
    for (const q of unanswered()) {
      const i = QUESTIONS.indexOf(q);
      const d = q.fallback(c);
      for (let tries = 0; ; tries++) {
        const typed = (await io.ask(`${paint('bold', askText(i))} ${d === undefined ? '' : paint('dim', `[${q.show(d, c)}]`) + ' '}`)).trim();
        if (!typed) {
          if (d !== undefined) answers[q.id] = d;
          break;
        }
        try {
          answers[q.id] = q.parse(typed, c);
          break;
        } catch (e) {
          if (tries >= 2) return err(e);
          io.stderr(`${paint('refused', '✗')} ${renderError(s, e as CatalogError)}\n`);
        }
      }
    }
    io.stdout('\n');
  }
  // --yes (and a dry run or the printed entry) take the default for anything still unanswered.
  for (const q of unanswered()) {
    const d = q.fallback(c);
    if (d !== undefined) answers[q.id] = d;
  }

  const config = configFrom(existing, file, answers, c);
  const sessionStartHook = config['session_start_hook'] !== false;
  const install = io.install ?? { node: process.execPath, script: SCRIPT, temporaryRoots: [tmpdir(), '/tmp', '/var/tmp'] };
  const input: PlanInput = {
    assistantHome: settings.assistantHome,
    skillsHome: settings.home,
    env: io.env,
    uid: io.uid ?? process.getuid?.() ?? -1,
    node: install.node,
    script: install.script,
    temporaryRoots: install.temporaryRoots,
    words: s,
    newId: io.newId ?? randomBytes(16).toString('hex'),
    sessionStartHook,
  };

  let plan: SetupPlan;
  try {
    plan = planSetup(input);
  } catch (e) {
    return err(e);
  }
  if (values['print-mcp-entry']) {
    io.stdout(JSON.stringify({ [s.serverName]: mcpEntry(plan.run) }, null, 2) + '\n');
    return 0;
  }

  const terminalCommand = config['terminal_command'] !== false;
  const lines = planLines(s, paint, plan, config, existing, io.env, terminalCommand);
  io.stdout(lines.join('\n') + '\n');
  if (dryRun) {
    io.stdout(s.setup.plan.dry_run + '\n');
    return 0;
  }
  if (!yes && io.tty) {
    const go = (await io.ask(`${paint('bold', s.setup.plan.ask)} `)).trim().toLowerCase();
    if (go && !['y', 'yes'].includes(go)) {
      io.stdout(s.setup.plan.declined + '\n');
      return 0;
    }
  }

  let ran: Awaited<ReturnType<typeof runSetup>>;
  try {
    ran = await runSetup({ ...input, config, terminalCommand, now: io.now ?? (() => Date.now()) });
  } catch (e) {
    return err(e);
  }
  io.stdout('\n' + (await summary(s, paint, ran, config, settings, io.env)).join('\n') + '\n');
  return 0;
}

/** The plan: the one remaining step first when setup runs inside Claude Code, then each file and what it gets. */
function planLines(s: Words, paint: Paint, plan: SetupPlan, config: Config, existing: Config, env: SetupIo['env'], terminalCommand: boolean): string[] {
  const w = s.setup.plan;
  const f = plan.files;
  const recorded = (kind: string) => (plan.record?.entries ?? []).some((e) => e.kind === kind);
  const out: string[] = [];
  if (env['CLAUDECODE']) out.push(paint('attention', w.inside));
  const configChanges = JSON.stringify(existing) !== JSON.stringify(config);
  const changes = [
    configChanges ? s.format(w.config, { path: join(plan.places.skillsHome, 'config.json') }) : undefined,
    f.claudeJson.text === undefined ? undefined : s.format(recorded('mcp_entry') ? w.mcp_replace : w.mcp_add, { path: f.claudeJson.path }),
    f.settingsJson.text === undefined ? undefined : s.format(!plan.hook ? w.rules_add : recorded('hook_group') ? w.hook_replace : w.hook_add, { path: f.settingsJson.path, rules: allowRules(s).length }),
    f.claudeJson.text === undefined && f.settingsJson.text === undefined ? undefined : s.format(w.record, { path: plan.places.record }),
    terminalCommand && !(plan.record?.created_files ?? []).some((c) => c.file === plan.places.command) ? s.format(w.command, { path: plan.places.command }) : undefined,
  ].filter((l): l is string => l !== undefined);
  if (!changes.length) return [...out, paint('ok', `✓ ${w.unchanged}`)];
  out.push(paint('bold', w.header), ...changes);
  if ([f.claudeJson, f.settingsJson].some((p) => p.text !== undefined && p.was !== 'absent')) out.push(s.format(w.backup, { folder: plan.places.backups }));
  return out;
}

async function catalogSize(settings: Settings, catalog: string): Promise<number> {
  try {
    const c = await openCatalog(catalog, { readOnly: true, named: true });
    try {
      return (await c.search({ query: '' })).catalog_size;
    } finally {
      c.close();
    }
  } catch {
    return 0;
  }
}

/** The summary: the one remaining step first, then the catalog, updates, the assistant, who you are, the terminal
 *  command, and anything the person should know (a shared folder, a permissive mode, the backups). */
async function summary(s: Words, paint: Paint, ran: Awaited<ReturnType<typeof runSetup>>, config: Config, before: Settings, env: SetupIo['env']): Promise<string[]> {
  const w = s.setup;
  const settings = settingsFrom(env, before.projectDir);
  const catalog = settings.catalog;
  const local = catalog.startsWith('file:');
  const where = local ? fileURLToPath(catalog) : catalog;
  const files = [ran.plan.files.claudeJson.path, ran.plan.files.settingsJson.path];
  const done = s.format(w.done, {
    next: env['CLAUDECODE'] ? w.next_claude_code_inside : w.next_claude_code,
    catalog: where,
    count: await catalogSize(settings, catalog),
    updates: config.update_policy === 'auto' ? w.updates_auto : w.updates_off,
    assistant: s.format(w.assistant_claude_code, { files: files.join(', ') }),
  }).trimEnd().split('\n');
  const out = [paint('ok', `✓ ${done[0]}`), ...done.slice(1)];
  out.push(typeof config['me'] === 'string' ? s.format(w.done_me, { me: config['me'] }) : w.done_me_none);
  if (Array.isArray(config['demo_developers']) && config['demo_developers'].length) out.push(s.format(w.done_demo, { names: config['demo_developers'].join(', ') }));
  // Commands the person may paste: each path quoted for the shell (a home folder can hold an apostrophe or a $).
  const runnable = `${shellQuote(ran.plan.run.node)} ${shellQuote(ran.plan.run.script)}`;
  const folder = ran.plan.places.commandDir;
  const command: Record<CommandOutcome, string> = {
    added: s.format(w.command_added, { path: ran.plan.places.command }),
    same: s.format(w.command_added, { path: ran.plan.places.command }),
    taken: s.format(w.command_taken, { path: ran.plan.places.command, runnable }),
    unsafe: s.format(w.command_unsafe, { folder, runnable }),
  };
  out.push(ran.command ? command[ran.command] : s.format(w.command_none, { runnable }));
  if (!local) out.push(paint('attention', s.format(w.catalog_hosted, { catalog })));
  const kind = local ? sharedFolderKind(where) : undefined;
  if (kind) out.push(paint('attention', `▲ ${s.format(w.catalog_shared_folder, { path: where, kind: w.shared_folder_kind[kind] })}`));
  const permissive = permissiveMode(settings);
  if (permissive.mode && permissive.mode !== 'unknown') out.push(paint('attention', `▲ ${s.format(w.updates_permissive_now, { mode: permissive.mode })}`));
  for (const u of permissive.unusable ?? []) out.push(paint('attention', `▲ ${s.format(w.updates_permissive_unknown, { path: u.path, why: s.format(w.settings_unusable[u.why], { key: 'key' in u ? u.key : '' }) })}`));
  if (ran.backups.length) {
    out.push(s.format(w.backups, { folder: ran.plan.places.backups }));
    const original = (b: string) => (b.endsWith('-claude.json') ? ran.plan.files.claudeJson.path : ran.plan.files.settingsJson.path);
    for (const b of ran.backups) out.push(s.format(w.restore, { file: original(b), backup: b }));
  }
  out.push(s.format(w.node, { node: ran.plan.run.node }));
  if ((ran.command === 'added' || ran.command === 'same') && !(env['PATH'] ?? '').split(':').some((p) => p && samePath(p, folder))) out.push(paint('attention', `▲ ${s.format(w.command_off_path, { folder: shellQuote(folder) })}`));
  return out;
}

const samePath = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
};
