// How the CLI looks to a person at a terminal: a few colours and marks, each with one meaning everywhere, and columns
// that line up. Colour only when the output is a terminal and NO_COLOR isn't set (https://no-color.org); without it
// every mark and word stays, so nothing depends on colour alone.

export type Tone = 'ok' | 'newer' | 'attention' | 'refused' | 'dim' | 'bold' | 'added' | 'removed';

// 256-colour codes: the orange is the demo's and the web page's "needs your yes" colour.
const SGR: Record<Tone, [string, string]> = {
  ok: ['\x1b[32m', '\x1b[39m'],
  newer: ['\x1b[36m', '\x1b[39m'],
  attention: ['\x1b[38;5;208m', '\x1b[39m'],
  refused: ['\x1b[31m', '\x1b[39m'],
  dim: ['\x1b[2m', '\x1b[22m'],
  bold: ['\x1b[1m', '\x1b[22m'],
  added: ['\x1b[32m', '\x1b[39m'],
  removed: ['\x1b[31m', '\x1b[39m'],
};

/** The marks, one meaning each: up to date or done, a newer version, waiting for the person, not done. */
export const MARK = { ok: '✓', newer: '↑', attention: '▲', refused: '✗' } as const;

export type Paint = { (tone: Tone, text: string): string; color: boolean };

export function painter(color: boolean): Paint {
  const paint = ((tone: Tone, text: string) => (color && text ? SGR[tone][0] + text + SGR[tone][1] : text)) as Paint;
  paint.color = color;
  return paint;
}

/** Colour for a person at a terminal: stdout is one, and NO_COLOR is unset or empty. */
export const wantsColor = (isTTY: boolean, env: Record<string, string | undefined>) => isTTY && !env['NO_COLOR'];

const ANSI = /\x1b\[[0-9;]*m/g;
/** The width a person sees: without colour codes, one column per character. */
export const width = (text: string) => [...text.replace(ANSI, '')].length;

/** Rows as columns that line up (each cell padded to its column's widest), two spaces apart, indented. A column empty
 *  in every row is left out. */
export function columns(all: readonly (readonly string[])[], indent = '  '): string[] {
  const used = (i: number) => all.some((r) => width(r[i] ?? '') > 0);
  const rows = all.map((r) => r.filter((_, i) => used(i)));
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, width(c))));
  return rows.map((r) => indent + r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i]! - width(c)))).join('  ').trimEnd());
}

/** A block the eye can't skip: every line behind a coloured bar. */
export const barred = (paint: Paint, tone: Tone, lines: readonly string[]) => lines.map((l) => paint(tone, '┃') + ' ' + l);

/** Text a publisher wrote, shown behind a plain gutter, so none of its lines can pass for the tool's own. */
export const guttered = (paint: Paint, text: string) => text.split('\n').map((l) => paint('dim', '│') + ' ' + l);
