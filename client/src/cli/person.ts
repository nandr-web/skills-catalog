// The CLI's results for a person at a terminal. An assistant reads the words file's sentences (they tell it what to do
// and what to tell the person); a person reads this: the same result, addressed to them, laid out to be seen at a
// glance. What needs their decision comes last, behind an orange bar, with the commands that answer it. Every word is
// the words file's (results.person); only the layout is here. A command with no view of its own here shows its text.
import { fenced, reasons, skillMdOf, type DiffResult, type ReadResult, type SearchInput, type SearchResult, type VersionsResult, type Words } from '@skills-catalog/core';
import { flagText, oneLine } from '@skills-catalog/core/skill-tree';
import type { ListView, UpdateView } from '../machine/installer.ts';
import type { Answer } from '../operations.ts';
import { MARK, barred, columns, guttered, type Paint } from './terminal.ts';

type Say = (path: string, fields?: Record<string, unknown>) => string;

/** The words at results.person.<path>, filled; a word with `one` and `other` picks by fields.n. */
const sayer = (s: Words): Say => (path, fields = {}) => {
  const w = s.word(`person.${path}`);
  const text = w && typeof w === 'object' && 'other' in w ? (fields['n'] === 1 ? w.one : w.other) : w;
  return s.format(String(text), fields);
};

const day = (iso: string) => iso.slice(0, 10);
const arrow = '→';

/** The person's view of an answer, or undefined when this operation has none (its text is shown). */
export function personView(s: Words, paint: Paint, op: string, a: Answer, args: Record<string, unknown>): string | undefined {
  const say = sayer(s);
  if (a.isError) return a.error ? error(s, say, paint, a) : undefined;
  switch (op) {
    case 'list_installed_skills':
      return list(say, paint, a.view as ListView | undefined);
    case 'update_installed_skills':
      return update(s, say, paint, a.view as UpdateView | undefined);
    case 'search_shared_skills':
      return search(say, paint, a.data as SearchResult, args as SearchInput);
    case 'read_shared_skill':
      return read(say, paint, a.data as ReadResult);
    case 'list_shared_skill_versions':
      return versions(say, paint, a.data as VersionsResult);
    case 'diff_shared_skill_versions':
      return diff(s, say, paint, a.data as DiffResult);
    default:
      return undefined;
  }
}

function list(say: Say, paint: Paint, v: ListView | undefined): string | undefined {
  if (!v) return undefined;
  if (!v.rows.length) return say('list.empty');
  const rows = v.rows.map((r) => [
    r.state === 'same' ? paint('ok', MARK.ok) : paint('newer', MARK.newer),
    paint('bold', r.name),
    `v${r.version}`,
    r.state === 'same' ? paint('dim', say('list.same')) : paint('newer', say('list.behind', { latest: r.latest })),
    paint('dim', say(`list.where.${r.target}`)),
    paint('dim', r.policy_words),
  ]);
  const out = [paint('bold', say('list.title', { n: v.rows.length })), '', ...columns(rows)];
  if (v.rows.some((r) => r.state === 'behind')) out.push('', say('list.next_behind'));
  return out.join('\n');
}

function update(s: Words, say: Say, paint: Paint, v: UpdateView | undefined): string | undefined {
  if (!v) return undefined;
  const out = [paint('bold', say('update.checked', { n: v.checked })), ''];
  const done = v.items.filter((i) => i.kind === 'updated' || i.kind === 'would_update');
  for (const i of done) out.push(`  ${paint('ok', MARK.ok)} ${say(`update.${i.kind}`, { name: paint('bold', i.name), from: i.from, to: i.to })}`);
  if (v.unchanged) out.push(`  ${paint('ok', MARK.ok)} ${paint('dim', say('update.unchanged', { n: v.unchanged }))}`);
  // Refusals keep their full sentence: each names what happened to the folder and what not to do.
  const refused = v.items.filter((i) => i.kind === 'refused');
  if (refused.length) {
    out.push('', paint('refused', `${MARK.refused} ${say('update.refused_title')}`));
    for (const i of refused) out.push(...i.lines.map((l) => '  ' + l.replace(/^- /, '')));
  }
  // What waits for the person: last, where the eye lands, behind a bar, each with why and the two commands.
  const held = v.items.filter((i) => i.kind.startsWith('held_'));
  if (held.length) {
    const block = [paint('attention', paint('bold', `${MARK.attention} ${say('update.waiting', { n: held.length })}`)), ''];
    for (const i of held) {
      const at = { name: i.name, from: i.from, to: i.to };
      block.push(paint('bold', say('update.held_title', at)));
      const why = i.kind === 'held_flagged' ? [] : [say(`update.why.${i.kind}`, at)];
      for (const f of i.flags) why.push(reasons(s, [f]));
      if (i.kind === 'held_flagged' && !i.flags.length) why.push(say('update.why.held_flagged', at));
      for (const w of why) block.push(`  • ${w}`);
      block.push('', `  ${say('update.look', at)}`, `  ${say('update.take', at)}`, paint('dim', `  ${say('update.stays', at)}`), '');
    }
    while (block.at(-1) === '') block.pop();
    out.push('', ...barred(paint, 'attention', block));
  }
  return out.join('\n');
}

function search(say: Say, paint: Paint, r: SearchResult, req: SearchInput): string {
  const query = req.query ?? '';
  if (r.catalog_size === 0) return say('search.empty_catalog');
  if (!r.results.length) return say('search.empty', { query, total: r.catalog_size });
  const partial = r.match === 'partial';
  const first = r.results.length;
  const header = partial
    ? paint('attention', `${MARK.attention} ${say('search.partial', { query })}`)
    : r.ranking === 'none'
      ? say(r.next_cursor || first < r.catalog_size ? 'search.header_page' : 'search.header_all', { total: r.catalog_size, first: 1, last: first })
      : say('search.header', { count: r.total_matches, total: r.catalog_size, query });
  const out = [paint('bold', header), ''];
  for (const c of r.results) {
    const meta = [`v${c.latest_version}`, oneLine(c.publisher), ...(c.tags.length ? [c.tags.map(oneLine).join(', ')] : [])].join(' · ');
    out.push(`  ${paint('bold', c.name)}  ${paint('dim', meta)}`);
    if (partial) out.push(`    ${paint('attention', say('search.shares', { words: c.matched_words.join(', ') }))}`);
    out.push(`    ${oneLine(c.description)}`, '');
  }
  if (r.next_cursor) out.push(say('search.more', { cursor: r.next_cursor }));
  out.push(paint('dim', say('search.next', { name: r.results[0]!.name })));
  return out.join('\n');
}

function read(say: Say, paint: Paint, r: ReadResult): string | undefined {
  // Several names, or one not found, keep their text: a mixed answer reads best as the words file gives it.
  if (r.skills.length !== 1 || 'error' in r.skills[0]!) return undefined;
  const item = r.skills[0]!;
  const publisher = oneLine(item.publisher);
  const latest_mark = item.version === item.latest_version ? '' : say('read.older', { latest: item.latest_version });
  const out = [paint('bold', say('read.header', { name: item.name, version: item.version, latest_mark, publisher, published_at: day(item.published_at) }))];
  const skillMd = skillMdOf(item);
  if (skillMd !== undefined) out.push('', paint('dim', say('read.as_written', { publisher })), ...guttered(paint, fenced(skillMd.trimEnd())));
  const files = item.files ?? [];
  if (files.length) out.push('', say('read.files', { files: files.map((f) => flagText(f.path)).join(', ') }));
  const left = files.filter((f) => f.content_omitted && f.path !== 'SKILL.md').map((f) => flagText(f.path));
  if (left.length) out.push(say('read.left_out', { files: left.join(', '), name: item.name }));
  out.push('', paint('dim', say('read.next', { name: item.name })));
  return out.join('\n');
}

function versions(say: Say, paint: Paint, r: VersionsResult): string {
  const rows = r.versions.map((v) => [paint('bold', `v${v.version}`), paint('dim', day(v.published_at)), oneLine(v.publisher), oneLine(v.message) || paint('dim', say('versions.no_message'))]);
  const out = [paint('bold', say('versions.header', { name: r.name, n: r.latest })), '', ...columns(rows)];
  if (r.next_cursor) out.push('', say('versions.more', { cursor: r.next_cursor }));
  if (r.latest > 1) out.push('', paint('dim', say('versions.next', { name: r.name, from: r.latest - 1, to: r.latest })));
  return out.join('\n');
}

function diff(s: Words, say: Say, paint: Paint, r: DiffResult): string {
  const at = { name: r.name, from: r.from, to: r.to };
  if (r.files.length === 0 && !r.publisher_changed) return say('diff.same', at);
  const out = [paint('bold', say('diff.header', { ...at, n: r.files.length })), ''];
  if (r.risk_flags.length) {
    const block = [paint('attention', paint('bold', `${MARK.attention} ${say('diff.runs')}`)), ...r.risk_flags.map((f) => `  • ${reasons(s, [f])}`)];
    out.push(...barred(paint, 'attention', block), '');
  } else out.push(`${paint('ok', MARK.ok)} ${say('diff.runs_no')}`, '');
  const tone = { added: 'added', changed: 'bold', removed: 'removed' } as const;
  const rows = r.files.map((f) => {
    const kind = f.flags.executable ? 'executable' : f.flags.script ? 'script' : f.flags.binary ? 'binary' : undefined;
    return [paint(tone[f.status], say(`diff.status.${f.status}`)), flagText(f.path), kind ? paint(f.flags.binary ? 'dim' : 'attention', say(`diff.kind.${kind}`)) : ''];
  });
  out.push(...columns(rows));
  const show = (v: unknown) => (v === null ? '-' : flagText(Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)));
  for (const c of r.frontmatter_changes) out.push(`  ${say('diff.frontmatter', { field: flagText(c.field), from: show(c.from), to: show(c.to) })}`);
  const publisher = r.risk_flags.find((f) => f.kind === 'new_publisher');
  if (publisher) out.push(`  ${say('diff.publisher', { from: flagText(String(publisher.from)), to: flagText(String(publisher.to)) })}`);
  // The changed lines are the publishers' text: behind the gutter, coloured by + and -.
  for (const f of r.files.filter((x) => x.unified)) {
    const lines = fenced(f.unified!.trimEnd()).split('\n').map((l) => (l.startsWith('+') && !l.startsWith('+++') ? paint('added', l) : l.startsWith('-') && !l.startsWith('---') ? paint('removed', l) : l.startsWith('@@') ? paint('newer', l) : paint('dim', l)));
    out.push('', ...guttered(paint, lines.join('\n')));
  }
  return out.join('\n');
}

// Errors: the sentence without its code, and a next step the person can type. Those with no words of their own here keep
// their text, only without the leading code (a person has no use for "not_found:").
function error(s: Words, say: Say, paint: Paint, a: Answer): string {
  const e = a.error!;
  const d = e.data as Record<string, unknown>;
  const mark = paint('refused', MARK.refused);
  if (e.code === 'not_found' && typeof d['name'] === 'string' && d['version'] === undefined && d['path'] === undefined) {
    const names = (d['suggestions'] as string[] | undefined) ?? [];
    const out = [`${mark} ${say('errors.not_found', { name: oneLine(d['name']) })}`];
    if (names.length) out.push(`  ${say('errors.not_found_suggest', { names: paint('bold', names.join(', ')) })}`);
    out.push(paint('dim', `  ${say('errors.not_found_next')}`));
    return out.join('\n');
  }
  if (e.code === 'not_installed' && typeof d['name'] === 'string') return `${mark} ${say('errors.not_installed', { name: oneLine(d['name']) })}`;
  return `${mark} ${a.text.replace(/^[a-z_]+: /, '')}`;
}

/** The first line before the usage, for a person who typed something the CLI doesn't take. */
export const usageLead = (s: Words) => sayer(s)('usage');
