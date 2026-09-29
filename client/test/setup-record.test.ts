// Setup's record (setup build notes, "The record"): exactly what setup added, so teardown removes only that. A record
// that isn't this shape can't prove anything is setup's, so it's refused whole (wrong_shape), never read in part.
import { describe, expect, it } from 'vitest';
import { recordWhy } from '../src/machine/setup-record.ts';

const ID = '0123456789abcdef0123456789abcdef';
const HASH = 'a'.repeat(64);
const good = () => ({
  version: 1,
  setup_id: ID,
  entries: [
    { kind: 'mcp_entry', file: '/h/.claude.json', value: { type: 'stdio', command: '/n', args: ['/s', 'mcp'], env: { SKILLS_SETUP_ID: ID } }, state: 'written', created: ['mcpServers'] },
    { kind: 'hook_group', file: '/h/.claude/settings.json', value: { hooks: [{ type: 'command', command: 'x', timeout: 10 }] }, state: 'pending', created: ['hooks', 'hooks.SessionStart'] },
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
  ];
  for (const [what, r] of bad) it(`refused: ${what}`, () => expect(recordWhy(r)).toBe('wrong_shape'));
});
