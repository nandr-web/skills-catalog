// The injected-command detector as reviewed at 15f3e65, kept only as the oracle for a differential test
// (risky-updates.test.ts): whatever it flags, the current detector must flag too. Copied as it was, never edited.

import { FLAG_TEXT_MAX, type Injection } from '../../src/skill-tree/diff.ts';
import { INVISIBLE } from '../../src/skill-tree/tree.ts';

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const ONE_INVISIBLE = new RegExp(`^(?:${INVISIBLE.source})$`, 'u');
const isBlank = (c: string) => c === ' ' || c === '\t' || ONE_INVISIBLE.test(c);
function skipBlanks(line: string, i: number): number {
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code === 0x20 || code === 0x09) {
      i++;
      continue;
    }
    if (code < 0x7f && code > 0x20) break;   // a printable ASCII character is never blank
    const c = String.fromCodePoint(line.codePointAt(i)!);
    if (!isBlank(c)) break;
    i += c.length;
  }
  return i;
}
type Fence = { char: string; length: number };
// A line that opens a ```! or ~~~! block: blanks, three or more of one fence character, blanks, then `!`.
function openingFence(line: string): Fence | null {
  let i = skipBlanks(line, 0);
  const char = line[i];
  if (char !== '`' && char !== '~') return null;
  const start = i;
  while (line[i] === char) i++;
  if (i - start < 3) return null;
  i = skipBlanks(line, i);
  return line[i] === '!' ? { char, length: i - start > 0 ? countRun(line, start, char) : 0 } : null;
}
const countRun = (line: string, from: number, char: string) => {
  let n = 0;
  while (line[from + n] === char) n++;
  return n;
};
// A line that closes it, strictly (so an edit after a doubtful close still counts as inside): up to three spaces, at
// least as many of the same character, then only spaces or tabs to the line's end.
function closesFence(line: string, fence: Fence): boolean {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const n = countRun(line, i, fence.char);
  if (n < fence.length) return false;
  for (i += n; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}
// A flag's detail shows the whole command, its lines or commands joined by a visible mark (then flagText cuts it).
const JOIN = ' ⏎ ';
const inlineCommands = (line: string) => {
  const out: string[] = [];
  for (let at = line.indexOf('!`'); at >= 0; at = line.indexOf('!`', at + 2)) {
    const end = line.indexOf('`', at + 2);
    out.push(line.slice(at + 2, end < 0 ? undefined : end).trim());
    if (end < 0) break;
    at = end - 1;
  }
  return out.filter(Boolean).join(JOIN);
};
export function injections15f3e65(text: string): Injection[] {
  const lines = text.split(LINE_BREAK);
  const out: Injection[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = openingFence(lines[i]!);
    if (open) {
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j]!, open)) j++;
      // The detail is cut to FLAG_TEXT_MAX anyway: stop collecting the command once it's longer than that.
      const body: string[] = [];
      for (let k = i + 1, n = 0; k < j && n <= FLAG_TEXT_MAX; k++) {
        const l = lines[k]!.trim().slice(0, FLAG_TEXT_MAX + 1);
        if (l) {
          body.push(l);
          n += l.length + JOIN.length;
        }
      }
      out.push({ line: i + 1, text: lines.slice(i, j + 1).join('\n'), command: body.length ? body.join(JOIN) : lines[i]!.trim().slice(0, FLAG_TEXT_MAX + 1) });
      i = j;
    } else if (lines[i]!.includes('!`')) out.push({ line: i + 1, text: lines[i]!, command: inlineCommands(lines[i]!) });
  }
  return out;
}
