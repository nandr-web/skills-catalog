// Where a person's view is shown, and how each kind of thing looks there (view.ts lays results out in these terms only):
// a terminal (the CLI: colour, columns, a bar), or markdown (the assistant's reply, which Claude Code and most chat
// clients render: tables, bold, a quoted box). The marks are the same in both.
import { barred, columns, guttered, painter, type Paint } from './terminal.ts';

export type Medium = {
  kind: 'terminal' | 'markdown';
  paint: Paint;
  /** A publisher's one-line text (a description, a name, a note), made safe to place in this medium. */
  text(s: string): string;
  /** Rows under a header; a column empty in every row is left out. The terminal shows no header row. */
  table(header: readonly string[], rows: readonly (readonly string[])[]): string[];
  /** What needs the person's decision: a block the eye can't skip. */
  callout(lines: readonly string[]): string[];
  /** A publisher's text of several lines (a SKILL.md, a diff), shown apart from ours: the caller has already shown its
   *  control characters escaped (core's fenced), so colour added after that stays colour. `lang` names it for markdown. */
  quoted(text: string, lang?: string): string[];
  /** Whether the person types commands here (the terminal), or answers the assistant (markdown). */
  commands: boolean;
};

export function terminal(color: boolean): Medium {
  const paint = painter(color);
  return {
    kind: 'terminal',
    paint,
    text: (s) => s,
    table: (_header, rows) => columns(rows),
    callout: (lines) => barred(paint, 'attention', lines),
    quoted: (text) => guttered(paint, text),
    commands: true,
  };
}

// Markdown: bold is the only tone that carries (a chat client shows no colours); the marks and the box do the rest.
const mdPaint = ((tone: string, text: string) => (tone === 'bold' && text ? `**${text}**` : text)) as Paint;
mdPaint.color = false;

// A publisher's text in markdown can't format itself, link, or break a table: its markdown characters are escaped.
const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>|#~]/g, (c) => `\\${c}`);

export const markdown: Medium = {
  kind: 'markdown',
  paint: mdPaint,
  text: escapeMd,
  table(header, rows) {
    const used = header.map((_, i) => rows.some((r) => (r[i] ?? '') !== ''));
    const pick = (r: readonly string[]) => r.filter((_, i) => used[i]);
    const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
    return [line(pick(header)), line(pick(header).map(() => '---')), ...rows.map((r) => line(pick(r)))];
  },
  callout: (lines) => lines.map((l) => (l ? `> ${l}` : '>')),
  quoted(text, lang = '') {
    // A fence longer than any run of backticks in the text, so the text can't close it.
    const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
    const fence = '`'.repeat(longest + 1);
    return [fence + lang, text, fence];
  },
  commands: false,
};
