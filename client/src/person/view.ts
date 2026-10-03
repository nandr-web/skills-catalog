// A result as a person sees it. An assistant reads the words file's sentences (they tell it what to do and what to tell
// the person); a person reads this: the same result, addressed to them, laid out to be seen at a glance, in a terminal
// (the CLI) or in the assistant's reply (markdown, handed to it with the MCP result). What needs their decision comes
// last, set apart (medium.ts's callout), with what answers it: the commands in a terminal, a question in a reply. Every
// word is the words file's (results.person); only the layout is here. A result with no view here has none.
import { fenced, reasons, sharesEveryWord, skillMdOf, type DiffResult, type ReadResult, type SearchInput, type SearchResult, type VersionsResult, type Words } from '@skills-catalog/core';
import { flagText, oneLine } from '@skills-catalog/core/skill-tree';
import type { ListView, UpdateView } from '../machine/installer.ts';
import type { Answer } from '../operations.ts';
import type { Medium } from './medium.ts';
import { MARK } from './terminal.ts';

type Say = (path: string, fields?: Record<string, unknown>) => string;

/** The words at results.person.<path>, filled; a word with `one` and `other` picks by fields.n. */
const sayer = (s: Words): Say => (path, fields = {}) => {
  const w = s.word(`person.${path}`);
  const text = w && typeof w === 'object' && 'other' in w ? (fields['n'] === 1 ? w.one : w.other) : w;
  return s.format(String(text), fields);
};

type Ctx = { s: Words; say: Say; m: Medium };

const day = (iso: string) => iso.slice(0, 10);
const header = (say: Say, path: string) => (say(path).split('|') as string[]).map((h) => h.trim());

/** The person's view of an answer in medium `m`, or undefined when this operation has none there. */
export function personView(s: Words, m: Medium, op: string, a: Answer, args: Record<string, unknown>): string | undefined {
  const c: Ctx = { s, say: sayer(s), m };
  if (a.isError) return a.error && m.kind === 'terminal' ? error(c, a) : undefined;
  switch (op) {
    case 'list_installed_skills':
      return list(c, a.view as ListView | undefined);
    case 'update_installed_skills':
      return update(c, a.view as UpdateView | undefined);
    case 'search_shared_skills':
      return search(c, a.data as SearchResult, args as SearchInput);
    case 'read_shared_skill':
      return m.kind === 'terminal' ? read(c, a.data as ReadResult) : undefined;
    case 'list_shared_skill_versions':
      return versions(c, a.data as VersionsResult);
    case 'diff_shared_skill_versions':
      return diff(c, a.data as DiffResult);
    default:
      return undefined;
  }
}

function list({ say, m }: Ctx, v: ListView | undefined): string | undefined {
  if (!v) return undefined;
  const { paint } = m;
  if (!v.rows.length) return m.commands ? say('list.empty') : say('list.empty_reply');
  const rows = v.rows.map((r) => [
    r.state === 'same' ? paint('ok', MARK.ok) : paint('newer', MARK.newer),
    paint('bold', r.name),
    `v${r.version}`,
    r.state === 'same' ? paint('dim', say('list.same')) : paint('newer', say('list.behind', { latest: r.latest })),
    // Where it applies only when it isn't the usual place (the person's own skills folder, for every project).
    r.target === 'project' ? paint('dim', say('list.project')) : '',
    paint('dim', r.policy_words),
  ]);
  const out = [paint('bold', say('list.title', { n: v.rows.length })), '', ...m.table(header(say, 'list.columns'), rows)];
  const behind = v.rows.filter((r) => r.state === 'behind').length;
  // In markdown the view asks nothing: the assistant asks the person its one question (a question here too made two).
  if (behind && m.commands) out.push('', say('list.next_behind'));
  return out.join('\n');
}

function update({ s, say, m }: Ctx, v: UpdateView | undefined): string | undefined {
  if (!v) return undefined;
  const { paint } = m;
  const out = [paint('bold', say('update.checked', { n: v.checked })), ''];
  const done = v.items.filter((i) => i.kind === 'updated' || i.kind === 'would_update');
  const lead = m.kind === 'terminal' ? '  ' : '- ';
  for (const i of done) out.push(`${lead}${paint('ok', MARK.ok)} ${say(`update.${i.kind}`, { name: paint('bold', i.name), from: i.from, to: i.to })}`);
  if (v.unchanged) out.push(`${lead}${paint('ok', MARK.ok)} ${paint('dim', say('update.unchanged', { n: v.unchanged }))}`);
  // Refusals keep their full sentence: each names what happened to the folder and what not to do.
  const refused = v.items.filter((i) => i.kind === 'refused');
  if (refused.length && m.kind === 'terminal') {
    out.push('', paint('refused', `${MARK.refused} ${say('update.refused_title')}`));
    for (const i of refused) out.push(...i.lines.map((l) => '  ' + l.replace(/^- /, '')));
  }
  // What waits for the person: last, where the eye lands, set apart, each with why and what answers it.
  const held = v.items.filter((i) => i.kind.startsWith('held_'));
  if (held.length) {
    const block = [paint('attention', paint('bold', `${MARK.attention} ${say('update.waiting', { n: held.length })}`)), ''];
    for (const i of held) {
      const at = { name: i.name, from: i.from, to: i.to };
      block.push(paint('bold', say('update.held_title', at)));
      const why = i.kind === 'held_flagged' ? [] : [say(`update.why.${i.kind}`, at)];
      for (const f of i.flags) why.push(reasons(s, [f]));
      if (i.kind === 'held_flagged' && !i.flags.length) why.push(say('update.why.held_flagged', at));
      const bullet = m.kind === 'terminal' ? '  • ' : '- ';
      for (const w of why) block.push(bullet + w);
      if (m.commands) block.push('', `  ${say('update.look', at)}`, `  ${say('update.take', at)}`, paint('dim', `  ${say('update.stays', at)}`), '');
      else block.push('', say('update.stays_reply', at), '');
    }
    while (block.at(-1) === '') block.pop();
    out.push('', ...m.callout(block));
  }
  return out.join('\n');
}

function search({ say, m }: Ctx, r: SearchResult, req: SearchInput): string {
  const { paint } = m;
  const query = m.text(req.query ?? '');
  if (r.catalog_size === 0) return say('search.empty_catalog');
  if (!r.results.length) return m.commands ? say('search.empty', { query, total: r.catalog_size }) : say('search.empty_reply', { query, total: r.catalog_size });
  const partial = r.match === 'partial';
  const first = r.results.length;
  const title = partial
    ? paint('attention', `${MARK.attention} ${say('search.partial', { query })}`)
    : r.ranking === 'none'
      ? say(r.next_cursor || first < r.catalog_size ? 'search.header_page' : 'search.header_all', { total: r.catalog_size, first: 1, last: first })
      : say('search.header', { count: r.full_matches ?? r.total_matches, total: r.catalog_size, query });
  const out = [paint('bold', title), ''];
  // On a page with matches, the cards sharing only some words come after them, under their own heading, with the words.
  const matches = partial ? r.results : r.results.filter((c) => sharesEveryWord(r, c));
  const extras = partial ? [] : r.results.filter((c) => !sharesEveryWord(r, c));
  if (m.kind === 'markdown') {
    // A table the person scans: one row per skill, what it does in its own words.
    const rows = (cs: typeof r.results, shares: boolean) => cs.map((c) => [paint('bold', c.name), `v${c.latest_version}`, m.text(oneLine(c.publisher)), ...(shares ? [m.text(c.matched_words.join(', '))] : []), m.text(oneLine(c.description))]);
    out.push(...m.table(header(say, partial ? 'search.columns_partial' : 'search.columns'), rows(matches, partial)));
    if (extras.length) out.push('', paint('attention', `${MARK.attention} ${say('search.also')}`), '', ...m.table(header(say, 'search.columns_partial'), rows(extras, true)));
    return out.join('\n');
  }
  const card = (c: (typeof r.results)[number], shares: boolean) => {
    const meta = [`v${c.latest_version}`, oneLine(c.publisher), ...(c.tags.length ? [c.tags.map(oneLine).join(', ')] : [])].join(' · ');
    out.push(`  ${paint('bold', c.name)}  ${paint('dim', meta)}`);
    if (shares) out.push(`    ${paint('attention', say('search.shares', { words: c.matched_words.join(', ') }))}`);
    out.push(`    ${oneLine(c.description)}`, '');
  };
  for (const c of matches) card(c, partial);
  if (extras.length) out.push(paint('attention', `${MARK.attention} ${say('search.also')}`), '');
  for (const c of extras) card(c, true);
  if (r.next_cursor) out.push(say('search.more', { cursor: r.next_cursor }));
  out.push(paint('dim', say('search.next', { name: r.results[0]!.name })));
  return out.join('\n');
}

function read({ say, m }: Ctx, r: ReadResult): string | undefined {
  // Several names, or one not found, keep their text: a mixed answer reads best as the words file gives it.
  if (r.skills.length !== 1 || 'error' in r.skills[0]!) return undefined;
  const { paint } = m;
  const item = r.skills[0]!;
  const publisher = oneLine(item.publisher);
  const latest_mark = item.version === item.latest_version ? '' : say('read.older', { latest: item.latest_version });
  const out = [paint('bold', say('read.header', { name: item.name, version: item.version, latest_mark, publisher, published_at: day(item.published_at) }))];
  const skillMd = skillMdOf(item);
  if (skillMd !== undefined) out.push('', paint('dim', say('read.as_written', { publisher })), ...m.quoted(fenced(skillMd.trimEnd()), 'markdown'));
  const files = item.files ?? [];
  if (files.length) out.push('', say('read.files', { files: files.map((f) => flagText(f.path)).join(', ') }));
  const left = files.filter((f) => f.content_omitted && f.path !== 'SKILL.md').map((f) => flagText(f.path));
  if (left.length) out.push(say('read.left_out', { files: left.join(', '), name: item.name }));
  out.push('', paint('dim', say('read.next', { name: item.name })));
  return out.join('\n');
}

function versions({ say, m }: Ctx, r: VersionsResult): string {
  const { paint } = m;
  const rows = r.versions.map((v) => [paint('bold', `v${v.version}`), paint('dim', day(v.published_at)), m.text(oneLine(v.publisher)), m.text(oneLine(v.message)) || paint('dim', say('versions.no_message'))]);
  const out = [paint('bold', say('versions.header', { name: r.name, n: r.latest })), '', ...m.table(header(say, 'versions.columns'), rows)];
  if (m.commands && r.next_cursor) out.push('', say('versions.more', { cursor: r.next_cursor }));
  if (m.commands && r.latest > 1) out.push('', paint('dim', say('versions.next', { name: r.name, from: r.latest - 1, to: r.latest })));
  return out.join('\n');
}

function diff({ s, say, m }: Ctx, r: DiffResult): string {
  const { paint } = m;
  const at = { name: r.name, from: r.from, to: r.to };
  if (r.files.length === 0 && !r.publisher_changed) return say('diff.same', at);
  const out = [paint('bold', say('diff.header', { ...at, n: r.files.length })), ''];
  const bullet = m.kind === 'terminal' ? '  • ' : '- ';
  if (r.risk_flags.length) out.push(...m.callout([paint('attention', paint('bold', `${MARK.attention} ${say('diff.runs')}`)), ...r.risk_flags.map((f) => bullet + reasons(s, [f]))]), '');
  else out.push(`${paint('ok', MARK.ok)} ${say('diff.runs_no')}`, '');
  const tone = { added: 'added', changed: 'bold', removed: 'removed' } as const;
  const rows = r.files.map((f) => {
    const kind = f.flags.executable ? 'executable' : f.flags.script ? 'script' : f.flags.binary ? 'binary' : undefined;
    return [paint(tone[f.status], say(`diff.status.${f.status}`)), m.text(flagText(f.path)), kind ? paint(f.flags.binary ? 'dim' : 'attention', say(`diff.kind.${kind}`)) : ''];
  });
  out.push(...m.table(header(say, 'diff.columns'), rows));
  const show = (v: unknown) => (v === null ? '-' : flagText(Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)));
  for (const c of r.frontmatter_changes) out.push(`${bullet}${m.text(say('diff.frontmatter', { field: flagText(c.field), from: show(c.from), to: show(c.to) }))}`);
  const publisher = r.risk_flags.find((f) => f.kind === 'new_publisher');
  if (publisher) out.push(`${bullet}${m.text(say('diff.publisher', { from: flagText(String(publisher.from)), to: flagText(String(publisher.to)) }))}`);
  // The changed lines are the publishers' text, apart from ours; in a terminal coloured by + and -.
  for (const f of r.files.filter((x) => x.unified)) {
    const text = fenced(f.unified!.trimEnd());
    const shown = m.kind === 'terminal'
      ? text.split('\n').map((l) => (l.startsWith('+') && !l.startsWith('+++') ? paint('added', l) : l.startsWith('-') && !l.startsWith('---') ? paint('removed', l) : l.startsWith('@@') ? paint('newer', l) : paint('dim', l))).join('\n')
      : text;
    out.push('', ...m.quoted(shown, 'diff'));
  }
  return out.join('\n');
}

// Errors (terminal only): the sentence without its code, and a next step the person can type. Those with no words of
// their own here keep their text, only without the leading code (a person has no use for "not_found:").
function error({ say, m }: Ctx, a: Answer): string {
  const { paint } = m;
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

/** The MCP result for an answer: the assistant's words, then the person's view in markdown (when it has one), under the
 *  line that tells the assistant what it is for. */
export function withPersonView(s: Words, m: Medium, op: string, a: Answer, args: Record<string, unknown>): string {
  const shown = personView(s, m, op, a, args);
  return shown === undefined ? a.text : `${a.text}\n\n${sayer(s)('for_person')}\n\n${shown}`;
}
