// Setup's edits to the person's assistant files, as splices of their text (setup build notes §2 and its byte pins): one
// span inserted, replaced or removed, every byte outside it copied as it was. A new member or item goes last in its
// container, so nothing existing moves; it's laid out as JSON.stringify at the container's indent step (its members'
// indent, or the container line's indent plus 2 spaces when it's empty or on one line), with the file's own line ending.
import type { JsonContainer as Container, JsonNode } from './json-text.ts';
/** A splice's result: the new text and where the inserted text sits; `interior` is what an empty container held before
 *  (its blanks), so taking the member out again gives it back. */
export type Spliced = { text: string; start: number; end: number; interior?: string };

const DEFAULT_STEP = '  ';

/** A new file's text: 2-space steps, LF, a final LF (byte pin 1). */
export const freshText = (value: object): string => `${JSON.stringify(value, null, 2)}\n`;

/** The file's line ending: its first one (a mixed file follows its first), LF when it has none. */
const eolOf = (text: string) => {
  const n = text.indexOf('\n');
  return n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n';
};
const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const indentAt = (text: string, at: number) => /^[ \t]*/.exec(text.slice(lineStart(text, at), at))![0];

// A child's start and end: a member runs from its key to the end of its value, an item is its value.
type Child = { start: number; end: number };
const childrenOf = (c: Container): Child[] => (c.kind === 'object' ? c.members.map((m) => ({ start: m.start, end: m.value.end })) : c.items);

/** The indent a child of `c` sits at and the container's indent step. */
function layout(text: string, c: Container): { indent: string; step: string } {
  const base = indentAt(text, c.start);
  const first = childrenOf(c)[0];
  if (first && text.lastIndexOf('\n', first.start) > c.start) {
    const indent = text.slice(lineStart(text, first.start), first.start);
    return { indent, step: indent.startsWith(base) && indent.length > base.length ? indent.slice(base.length) : DEFAULT_STEP };
  }
  return { indent: base + DEFAULT_STEP, step: DEFAULT_STEP };
}

const render = (value: unknown, step: string, indent: string, eol: string) => JSON.stringify(value, null, step).split('\n').join(eol + indent);

function insert(text: string, c: Container, piece: (step: string, indent: string, eol: string) => string): Spliced {
  const eol = eolOf(text);
  const { indent, step } = layout(text, c);
  const children = childrenOf(c);
  const last = children.at(-1);
  if (last) {
    const added = `,${eol}${indent}${piece(step, indent, eol)}`;
    return { text: text.slice(0, last.end) + added + text.slice(last.end), start: last.end, end: last.end + added.length };
  }
  // An empty container: its blanks are replaced, and kept for when it's emptied again.
  const inside = c.start + 1;
  const interior = text.slice(inside, c.end - 1);
  const added = `${eol}${indent}${piece(step, indent, eol)}${eol}${indentAt(text, c.start)}`;
  return { text: text.slice(0, inside) + added + text.slice(c.end - 1), start: inside, end: inside + added.length, interior };
}

/** `key: value` added last in the object `c`. */
export const insertMember = (text: string, c: Container, key: string, value: unknown): Spliced =>
  insert(text, c, (step, indent, eol) => `${JSON.stringify(key)}: ${render(value, step, indent, eol)}`);

/** `value` added last in the array `c`. */
export const appendItem = (text: string, c: Container, value: unknown): Spliced => insert(text, c, (step, indent, eol) => render(value, step, indent, eol));

/** The value at `node`, a child of `c`, replaced by `value` at the same place, laid out as a new child would be. */
export function replaceValue(text: string, node: JsonNode, value: unknown, c: Container): string {
  const { indent, step } = layout(text, c);
  return text.slice(0, node.start) + render(value, step, indent, eolOf(text)) + text.slice(node.end);
}

function remove(text: string, c: Container, index: number, interior = ''): string {
  const children = childrenOf(c);
  const child = children[index]!;
  if (children.length === 1) return text.slice(0, c.start + 1) + interior + text.slice(c.end - 1);
  // After another child: from that child's end (the comma before this one) to this one's end; the first: up to the next.
  if (index > 0) return text.slice(0, children[index - 1]!.end) + text.slice(child.end);
  return text.slice(0, child.start) + text.slice(children[1]!.start);
}

/** The member `key` taken out of the object `c`; `interior` is the blanks an emptied object gets back. */
export function removeMember(text: string, c: Container, key: string, interior?: string): string {
  if (c.kind !== 'object') throw new Error('not an object');
  const index = c.members.findIndex((m) => m.key === key);
  if (index < 0) throw new Error(`no member ${key}`);
  return remove(text, c, index, interior);
}

/** The item at `index` taken out of the array `c`; `interior` is the blanks an emptied array gets back. */
export const removeItem = (text: string, c: Container, index: number, interior?: string): string => remove(text, c, index, interior);
