// The merge's own check, against a splicer made faulty on purpose: a splice that changes a byte of the person's outside
// its span, in a way parsing can't see, is internal_error and nothing is written (build notes §2).
import { describe, expect, it, vi } from 'vitest';
import { mergeClaudeJson, mergeSettingsJson } from '../src/machine/setup-merge.ts';
import { fileOf, golden, HOOK_GROUP, MCP_ENTRY, RULES } from './setup-golden.ts';

// Each splice also turns the person's first `1.0` into `1`: the same value, other bytes.
vi.mock('../src/machine/json-splice.ts', async (original) => {
  const real = await original<typeof import('../src/machine/json-splice.ts')>();
  const spoil = <T extends { text: string }>(s: T): T => ({ ...s, text: s.text.replace('1.0', '1') });
  return {
    ...real,
    insertMember: (...a: Parameters<typeof real.insertMember>) => spoil(real.insertMember(...a)),
    appendItem: (...a: Parameters<typeof real.appendItem>) => spoil(real.appendItem(...a)),
    replaceValue: (...a: Parameters<typeof real.replaceValue>) => real.replaceValue(...a).replace('1.0', '1'),
  };
});

describe('a splice that changes the person\'s bytes outside its span', () => {
  it('is internal_error for each file, though the values parse the same', () => {
    expect(mergeClaudeJson(fileOf(golden.kept_input.claude_json), MCP_ENTRY, [])).toEqual({ refusal: { code: 'internal_error' } });
    const settings = fileOf(golden.kept_input.settings_json).replace('"model": "opus"', '"ratio": 1.0');
    expect(mergeSettingsJson(settings, { hook: HOOK_GROUP, rules: RULES, id: '0123456789abcdef0123456789abcdef' }, [])).toEqual({ refusal: { code: 'internal_error' } });
  });
});
