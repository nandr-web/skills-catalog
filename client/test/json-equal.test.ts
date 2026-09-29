// Two parsed JSON values compared as JSON (setup build notes §2's check after every splice): objects by their keys and
// values in any order, lists in order. Iterative, so a file nested as deep as its size allows never overflows the stack.
import { describe, expect, it } from 'vitest';
import { jsonEqual } from '../src/machine/json-equal.ts';

// A value nested `depth` deep: {"a": {"a": ... leaf}} or [[... leaf]].
const nest = (depth: number, leaf: unknown, list = false): unknown => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = list ? [v] : { a: v };
  return v;
};

describe('comparing parsed JSON values', () => {
  it('equal: the same values, objects in any key order', () => {
    const pairs: [unknown, unknown][] = [
      [null, null],
      [1, 1],
      ['é', 'é'],
      [true, true],
      [{}, {}],
      [[], []],
      [{ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }],
      [{ '10': 'ten', '2': 'two' }, { '2': 'two', '10': 'ten' }],
    ];
    for (const [a, b] of pairs) expect([a, jsonEqual(a, b)]).toEqual([a, true]);
  });

  it('not equal: another value, type, length, order in a list, or a key more or less', () => {
    const pairs: [unknown, unknown][] = [
      [1, 2],
      [1, '1'],
      [0, false],
      [null, {}],
      [{}, []],
      [[1, 2], [2, 1]],
      [[1], [1, 1]],
      [{ a: 1 }, { a: 1, b: 1 }],
      [{ a: 1, b: 1 }, { a: 1 }],
      [{ a: undefined }, {}],
      [{ a: { b: [1, 2] } }, { a: { b: [1, 3] } }],
    ];
    for (const [a, b] of pairs) {
      expect([a, b, jsonEqual(a, b)]).toEqual([a, b, false]);
      expect([b, a, jsonEqual(b, a)]).toEqual([b, a, false]);
    }
  });

  it('a key that looks like one of Object\'s own is only a key', () => {
    expect(jsonEqual({ constructor: 1 }, {})).toBe(false);
    expect(jsonEqual(JSON.parse('{"__proto__": 1}'), JSON.parse('{"__proto__": 1}'))).toBe(true);
    expect(jsonEqual(JSON.parse('{"__proto__": 1}'), {})).toBe(false);
  });

  it('nested 200,000 deep, as objects and as lists, without overflowing the stack', () => {
    for (const list of [false, true]) {
      expect(jsonEqual(nest(200_000, 1, list), nest(200_000, 1, list))).toBe(true);
      expect(jsonEqual(nest(200_000, 1, list), nest(200_000, 2, list))).toBe(false);
    }
  });
});
