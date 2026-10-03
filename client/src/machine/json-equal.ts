// Two parsed JSON values compared as JSON (setup build notes §2: after every splice, the new text's value without setup's
// entries must equal the old text's): objects by their own keys and values in any order, lists in order, the rest by
// value. Iterative, never recursive, so a file nested as deep as its size allows can't overflow the stack.

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function jsonEqual(a: unknown, b: unknown): boolean {
  const pending: [unknown, unknown][] = [[a, b]];
  while (pending.length) {
    const [x, y] = pending.pop()!;
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) pending.push([x[i], y[i]]);
    } else if (isObject(x)) {
      if (!isObject(y)) return false;
      const keys = Object.keys(x);
      if (keys.length !== Object.keys(y).length) return false;
      for (const k of keys) {
        if (!Object.hasOwn(y, k)) return false;
        pending.push([x[k], y[k]]);
      }
    } else if (x !== y) return false;
  }
  return true;
}
