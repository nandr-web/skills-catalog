// Where each value sits in a JSON file's text, so setup can change its own entries in the person's assistant files by
// splicing text, never by parsing and rewriting a whole file (which would change numbers past 2^53, `1.0`, `\u` escapes,
// the order of integer-like keys, indentation and line endings). JSON.parse is the strict check (V8's parser doesn't
// recurse); the scan after it is iterative too, and keeps members only for the containers the caller follows, so a large
// or deeply nested file costs no more than its text.

/** A value's place in the text: `start` at its first character, `end` just after its last (UTF-16 offsets). */
export type JsonNode =
  | { kind: 'object'; start: number; end: number; members: JsonMember[] }
  | { kind: 'array'; start: number; end: number; items: JsonNode[] }
  | { kind: 'string' | 'number' | 'literal'; start: number; end: number };
/** An object's member: its key, where the member starts (its key's opening quote) and its value. */
export type JsonMember = { key: string; start: number; value: JsonNode };

/** Why a file's text can't be used: not strict JSON with an object at the top, or a key on the followed path twice. */
export class JsonTextError extends Error {
  readonly why: 'not_json' | 'duplicate_key';
  readonly key?: string;
  constructor(why: 'not_json' | 'duplicate_key', key?: string) {
    super(key === undefined ? why : `${why}: ${key}`);
    this.why = why;
    if (key !== undefined) this.key = key;
  }
}

type Container = Extract<JsonNode, { kind: 'object' | 'array' }>;
type Frame = { node: Container; path: string[] | null; key?: string; keyStart?: number; expectKey: boolean; seen: Set<string> };

const WS = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The value at the top of `text` with the places of its members. `follow(path)` says whether an object at that path of
 *  keys (the top is []) keeps its members; an array kept by a followed object keeps its items. `once` names, per path
 *  joined with '.', the keys that may appear only once there (setup's own path: two of them is `duplicate_key`). */
export function scanJson(text: string, follow: (path: readonly string[]) => boolean, once: Readonly<Record<string, readonly string[]>> = {}): JsonNode {
  let value: unknown;
  try {
    if (text.charCodeAt(0) === 0xfeff) throw new Error('byte-order mark');
    value = JSON.parse(text);
  } catch {
    throw new JsonTextError('not_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new JsonTextError('not_json');

  const stack: Frame[] = [];
  let root: JsonNode | undefined;
  let i = 0;
  const skip = () => {
    while (WS.has(text[i]!)) i++;
  };
  const stringEnd = (at: number) => {
    let j = at + 1;
    for (;;) {
      const c = text.charCodeAt(j);
      if (c === 0x5c) j += 2;
      else if (c === 0x22) return j + 1;
      else j++;
    }
  };
  // A value found at the top of the stack: kept as its container's member or item when that container is followed.
  const found = (node: JsonNode) => {
    const f = stack.at(-1);
    if (!f) root = node;
    else if (f.path) {
      if (f.node.kind === 'object') f.node.members.push({ key: f.key!, start: f.keyStart!, value: node });
      else f.node.items.push(node);
    }
    if (f?.node.kind === 'object') f.expectKey = true;
  };

  for (;;) {
    skip();
    const f = stack.at(-1);
    const c = text[i];
    if (f && (c === '}' || c === ']')) {
      f.node.end = i + 1;
      stack.pop();
      i++;
      if (!stack.length) break;
      continue;
    }
    if (f && c === ',') {
      i++;
      continue;
    }
    if (f?.node.kind === 'object' && f.expectKey) {
      const end = stringEnd(i);
      const key = JSON.parse(text.slice(i, end)) as string;
      if (f.path && (once[f.path.join('.')] ?? []).includes(key)) {
        if (f.seen.has(key)) throw new JsonTextError('duplicate_key', key);
        f.seen.add(key);
      }
      f.key = key;
      f.keyStart = i;
      i = end;
      skip();
      i++; // the colon
      f.expectKey = false;
      continue;
    }
    if (c === '{' || c === '[') {
      // An object's members are followed by its path of keys; an array's items by its own object's following.
      const path = !f ? [] : f.path && f.node.kind === 'object' ? [...f.path, f.key!] : null;
      const followed = path !== null && follow(path);
      const node: Container = c === '{' ? { kind: 'object', start: i, end: -1, members: [] } : { kind: 'array', start: i, end: -1, items: [] };
      found(node);
      stack.push({ node, path: followed ? path : null, expectKey: c === '{', seen: new Set() });
      i++;
      continue;
    }
    const start = i;
    if (c === '"') i = stringEnd(i);
    else if (c === 't' || c === 'n') i += 4;
    else if (c === 'f') i += 5;
    else {
      NUMBER.lastIndex = i;
      NUMBER.test(text);
      i = NUMBER.lastIndex;
    }
    found({ kind: c === '"' ? 'string' : c === 't' || c === 'f' || c === 'n' ? 'literal' : 'number', start, end: i });
  }
  return root!;
}
