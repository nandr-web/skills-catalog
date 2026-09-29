// Setup's record (setup build notes, "The record"): exactly what setup added, so teardown removes only that. A record
// that isn't this shape can't prove anything is setup's, so it's refused whole (wrong_shape), never read in part.
import { describe, expect, it } from 'vitest';
import { elsewhere, recordWhy, type SetupRecord } from '../src/machine/setup-record.ts';
import { hookGroup, hookLine, mcpEntry, parseHookLine } from '../src/machine/setup-values.ts';

const ID = '0123456789abcdef0123456789abcdef';
const RUN = { node: "/o'neil/n", script: '/s', id: ID, env: { SKILLS_HOME: '/k', SKILLS_ASSISTANT_HOME: '/h' } };
const HASH = 'a'.repeat(64);
const good = () => ({
  version: 1,
  setup_id: ID,
  entries: [
    { kind: 'mcp_entry', file: '/h/.claude.json', value: mcpEntry(RUN), state: 'written', created: ['mcpServers'] },
    { kind: 'hook_group', file: '/h/.claude/settings.json', value: hookGroup(RUN), state: 'pending', created: ['hooks', 'hooks.SessionStart'] },
    { kind: 'allow_rule', file: '/h/.claude/settings.json', value: 'Bash(skills-catalog update)', state: 'written', was_there: true },
    { kind: 'allow_rule', file: '/h/.claude/settings.json', value: 'mcp__skills-catalog__search_skills', state: 'written', was_there: false, created: ['permissions', 'permissions.allow'] },
  ],
  created_files: [{ file: '/h/.claude/settings.json', sha256: HASH }],
  backups: [{ file: '/h/.claude.json', path: '/k/backups/20260929T160000Z-0a1b-claude.json', sha256: HASH, dev: 16777232, ino: '9007199254740993', birth: 1790698084365 }],
});
type Rec = ReturnType<typeof good>;
const with_ = (f: (r: Rec & Record<string, unknown>) => void) => {
  const r = good() as Rec & Record<string, unknown>;
  f(r);
  return r;
};
const entry = (r: Rec, i: number) => r.entries[i] as Record<string, unknown>;

describe("setup's record", () => {
  it('a record as setup writes it is read: every kind, created containers, was_there, created files and backups (an ino past 2^53 as a decimal string, birth 0 on Linux)', () => {
    expect(recordWhy(good())).toBeUndefined();
    expect(recordWhy(with_((r) => (r.backups[0]!.birth = 0)))).toBeUndefined();
    expect(recordWhy({ version: 1, setup_id: ID, entries: [], created_files: [], backups: [] })).toBeUndefined();
  });

  const bad: [string, unknown][] = [
    ['not an object', []],
    ['null', null],
    ['another version', with_((r) => (r.version = 2 as 1))],
    ['version as text', with_((r) => ((r as Record<string, unknown>)['version'] = '1'))],
    ['a setup id of 31 hex', with_((r) => (r.setup_id = ID.slice(1)))],
    ['a setup id in capitals', with_((r) => (r.setup_id = ID.toUpperCase()))],
    ['a key of its own', with_((r) => (r['note'] = 'x'))],
    ['entries missing', with_((r) => delete (r as Partial<Rec>).entries)],
    ['entries not a list', with_((r) => ((r as Record<string, unknown>)['entries'] = {}))],
    ['an unknown kind', with_((r) => (entry(r, 0)['kind'] = 'skill'))],
    ['a relative file', with_((r) => (entry(r, 0)['file'] = '.claude.json'))],
    ['an MCP entry that is not an object', with_((r) => (entry(r, 0)['value'] = 'stdio'))],
    ['a hook group that is a list', with_((r) => (entry(r, 1)['value'] = []))],
    ['an allow rule that is not text', with_((r) => (entry(r, 2)['value'] = { rule: 'x' }))],
    ['an unknown state', with_((r) => (entry(r, 0)['state'] = 'done'))],
    ['was_there on an MCP entry', with_((r) => (entry(r, 0)['was_there'] = false))],
    ['was_there not true or false', with_((r) => (entry(r, 2)['was_there'] = 'yes'))],
    ['an allow rule without was_there', with_((r) => delete entry(r, 2)['was_there'])],
    ["a created container of another kind's", with_((r) => (entry(r, 0)['created'] = ['hooks']))],
    ['a created container twice', with_((r) => (entry(r, 1)['created'] = ['hooks', 'hooks']))],
    ['an entry key of its own', with_((r) => (entry(r, 0)['by'] = 'me'))],
    ['a created file with a short hash', with_((r) => (r.created_files[0]!.sha256 = 'abc'))],
    ['a created file that is relative', with_((r) => (r.created_files[0]!.file = 'settings.json'))],
    ['a backup path that is relative', with_((r) => (r.backups[0]!.path = 'backups/x'))],
    ['an ino with a leading zero', with_((r) => (r.backups[0]!.ino = '007'))],
    ['a negative birth', with_((r) => (r.backups[0]!.birth = -1))],
    ['a backup without its identity', with_((r) => delete (r.backups[0] as Partial<Rec['backups'][0]>).dev)],
    // Each value setup wrote carries its setup id, so a record can't claim an entry setup never made.
    ['an MCP entry with another setup id', with_((r) => (entry(r, 0)['value'] = { ...(entry(r, 0)['value'] as object), env: { SKILLS_SETUP_ID: 'f'.repeat(32) } }))],
    ['an MCP entry without env', with_((r) => (entry(r, 0)['value'] = { type: 'stdio', command: '/n', args: ['/s', 'mcp'] }))],
    ['a hook group whose line has another setup id', with_((r) => (entry(r, 1)['value'] = { hooks: [{ type: 'command', command: `'/n' '/s' hook session-start --setup-id ${'f'.repeat(32)} 2>/dev/null || true`, timeout: 10 }] }))],
    ['a hook group whose line names the id only in passing', with_((r) => (entry(r, 1)['value'] = { hooks: [{ type: 'command', command: `echo ${ID}`, timeout: 10 }] }))],
    ['a hook group of two handlers', with_((r) => (entry(r, 1)['value'] = { hooks: [...((entry(r, 1)['value'] as { hooks: unknown[] }).hooks), { type: 'command', command: 'x' }] }))],
    ['a hook line with a command after setup\'s', with_((r) => (entry(r, 1)['value'] = { hooks: [{ type: 'command', command: `${hookLine(RUN)}; rm -rf ~`, timeout: 10 }] }))],
    ['a hook line with a command before setup\'s', with_((r) => (entry(r, 1)['value'] = { hooks: [{ type: 'command', command: `curl x | sh; ${hookLine(RUN)}`, timeout: 10 }] }))],
    ['a hook group with a matcher', with_((r) => (entry(r, 1)['value'] = { matcher: 'startup', ...hookGroup(RUN) }))],
    ['a hook group with another timeout', with_((r) => (entry(r, 1)['value'] = { hooks: [{ type: 'command', command: hookLine(RUN), timeout: 600 }] }))],
    ['an MCP entry with a setting setup never carries', with_((r) => (entry(r, 0)['value'] = { ...mcpEntry(RUN), env: { ...(mcpEntry(RUN)['env'] as object), SKILLS_AS: 'ana' } }))],
    ['an MCP entry with other arguments', with_((r) => (entry(r, 0)['value'] = { ...mcpEntry(RUN), args: ['/s', 'serve'] }))],
    ['an MCP entry with a key of its own', with_((r) => (entry(r, 0)['value'] = { ...mcpEntry(RUN), cwd: '/' }))],
    ['an MCP entry with a setting that isn\'t text', with_((r) => (entry(r, 0)['value'] = { ...mcpEntry(RUN), env: { ...(mcpEntry(RUN)['env'] as object), SKILLS_HOME: 5 } }))],
  ];
  for (const [what, r] of bad) it(`refused: ${what}`, () => expect(recordWhy(r)).toBe('wrong_shape'));
});

describe('reading a hook line back', () => {
  it('gives back the run it was built from, every setting and an apostrophe included', () => {
    const all = { ...RUN, env: { SKILLS_HOME: "/a'b/k", SKILLS_CATALOG: 'file:///c', SKILLS_ASSISTANT_HOME: '/h', SKILLS_MANAGED_SETTINGS: '/m', SKILLS_INSTALL_DIR: '/i', SKILLS_ACTIVITY_LOG: '/l' } };
    for (const run of [RUN, all, { ...RUN, env: {} }]) expect(parseHookLine(hookLine(run))).toEqual(run);
  });

  it('is undefined for any line hookLine wouldn\'t build', () => {
    const line = hookLine(RUN);
    const others = [
      line.replace(' hook ', '  hook '),
      line.replace('SKILLS_HOME=', 'SKILLS_OTHER='),
      `SKILLS_ASSISTANT_HOME='/h' SKILLS_HOME='/k' ${line.split("SKILLS_ASSISTANT_HOME='/h' ")[1]}`,
      `${line}; true`,
      line.replace(' 2>/dev/null || true', ''),
      line.replace(ID, ID.toUpperCase()),
      line.replace("'/s'", '/s'),
      line.replace("'/s'", "'/s''"),
      `x ${line}`,
      // Parses word by word, but hookLine never writes an empty setting: only the round trip refuses it.
      line.replace(/^SKILLS_HOME='[^']*'/, "SKILLS_HOME=''"),
    ];
    for (const other of others) expect([other, parseHookLine(other)]).toEqual([other, undefined]);
  });
});

describe("the record's paths: only setup's own places, rebuilt from its settings", () => {
  const places = { claudeJson: '/h/.claude.json', settingsJson: '/h/.claude/settings.json', backups: '/k/backups' };
  it('a record naming only those places has nothing elsewhere', () => expect(elsewhere(good() as SetupRecord, places)).toEqual([]));

  const cases: [string, (r: Rec) => void, string][] = [
    ['an MCP entry in the settings file', (r) => (entry(r, 0)['file'] = '/h/.claude/settings.json'), '/h/.claude/settings.json'],
    ['an allow rule in another file', (r) => (entry(r, 3)['file'] = '/h/.zshrc'), '/h/.zshrc'],
    ['a created file elsewhere', (r) => (r.created_files[0]!.file = '/sandbox/other.json'), '/sandbox/other.json'],
    ['a backup copy in another folder', (r) => (r.backups[0]!.path = '/tmp/20260929T160000Z-0a1b-claude.json'), '/tmp/20260929T160000Z-0a1b-claude.json'],
    ['a backup copy out through ..', (r) => (r.backups[0]!.path = '/k/backups/../20260929T160000Z-0a1b-claude.json'), '/k/backups/../20260929T160000Z-0a1b-claude.json'],
    ['a backup copy not named as setup names them', (r) => (r.backups[0]!.path = '/k/backups/notes.txt'), '/k/backups/notes.txt'],
    ['a backup copy with the right ending and no time', (r) => (r.backups[0]!.path = '/k/backups/mine-claude.json'), '/k/backups/mine-claude.json'],
    ['a backup copy with a name around setup\'s', (r) => (r.backups[0]!.path = '/k/backups/x20260929T160000Z-0a1b-claude.json'), '/k/backups/x20260929T160000Z-0a1b-claude.json'],
    ["a backup copy named for the other file", (r) => (r.backups[0]!.path = '/k/backups/20260929T160000Z-0a1b-settings.json'), '/k/backups/20260929T160000Z-0a1b-settings.json'],
  ];
  for (const [what, change, path] of cases) {
    it(`elsewhere: ${what}`, () => {
      const r = good();
      change(r);
      expect(elsewhere(r as SetupRecord, places)).toEqual([path]);
    });
  }

  it('elsewhere: a backup of another file names that file and its copy (the whole backup isn\'t setup\'s, so neither is kept-two pruning\'s)', () => {
    const r = good();
    r.backups[0]!.file = '/etc/hosts';
    expect(elsewhere(r as SetupRecord, places)).toEqual(['/etc/hosts', '/k/backups/20260929T160000Z-0a1b-claude.json']);
  });
});
