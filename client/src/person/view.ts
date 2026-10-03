// A result as a person sees it. An assistant reads the words file's sentences (they tell it what to do and what to tell
// the person); a person reads this: the same result, addressed to them, laid out to be seen at a glance, in a terminal
// (the CLI) or in the assistant's reply (markdown, handed to it with the MCP result). What needs their decision comes
// last, set apart (medium.ts's callout), with what answers it: the commands in a terminal, a question in a reply. Every
// word is the words file's (results.person); only the layout is here. A result with no view here has none.
import { fenced, manifestRefusal, reasons, skillMdOf, type DiffResult, type ReadResult, type SearchInput, type SearchResult, type VersionsResult, type Words } from '@skills-catalog/core';
import { flagText, oneLine } from '@skills-catalog/core/skill-tree';
import type { InstallView, ListView, UpdateView } from '../machine/installer.ts';
import type { PublishView } from '../machine/publish-folder.ts';
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

// A time as the person reads it: their own date and time (a UTC day alone shows an evening publish as tomorrow, and two
// versions the same day look the same; review P11.4).
const pad = (n: number) => String(n).padStart(2, '0');
const day = (iso: string) => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso.slice(0, 10);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
};
const header = (say: Say, path: string) => (say(path).split('|') as string[]).map((h) => h.trim());

/** The person's view of an answer in medium `m`, or undefined when this operation has none there. */
export function personView(s: Words, m: Medium, op: string, a: Answer, args: Record<string, unknown>): string | undefined {
  const c: Ctx = { s, say: sayer(s), m };
  if (a.isError) return a.error ? error(c, a) : undefined;
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
    case 'publish_skill_to_catalog':
      return publish(c, a.view as PublishView | undefined);
    case 'install_shared_skill':
    case 'accept_held_update':
      return install(c, a.view as InstallView | undefined);
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
    r.state === 'same' ? paint('dim', say('list.same')) : paint('newer', say(r.policy === 'auto' ? 'list.behind_auto' : 'list.behind', { latest: r.latest })),
    // Where it applies only when it isn't the usual place (the person's own skills folder, for every project).
    [r.target === 'project' ? paint('dim', say('list.project')) : '', r.edited ? paint('bold', say('list.edited')) : ''].filter(Boolean).join(', '),
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
  const lead = m.kind === 'terminal' ? '  ' : '- ';
  // A dry run's lines are what would happen: ↑, under a title that says nothing changed (✓ is for what was done).
  const would = v.items.filter((i) => i.kind === 'would_update');
  if (would.length) out.push(paint('bold', say('update.dry_run_title')));
  for (const i of would) out.push(`${lead}${paint('newer', MARK.newer)} ${say('update.would_update', { name: paint('bold', i.name), from: i.from, to: i.to })}`);
  for (const i of v.items.filter((i) => i.kind === 'updated')) out.push(`${lead}${paint('ok', MARK.ok)} ${say('update.updated', { name: paint('bold', i.name), from: i.from, to: i.to })}`);
  // A pin is the person's own choice, not a question: a plain line, outside the box (review V3.1).
  for (const i of v.items.filter((i) => i.kind === 'held_pin')) {
    out.push(`${lead}${paint('newer', MARK.newer)} ${say('update.pinned', { name: paint('bold', i.name), from: i.from, to: i.to })}`);
    if (m.commands) out.push(paint('dim', `    ${say('update.pinned_take', { name: i.name, to: i.to })}`));
  }
  if (v.unchanged) out.push(`${lead}${paint('ok', MARK.ok)} ${paint('dim', say('update.unchanged', { n: v.unchanged }))}`);
  // Refusals keep their full sentence: each names what happened to the folder and what not to do.
  const refused = v.items.filter((i) => i.kind === 'refused');
  if (refused.length && m.kind === 'terminal') {
    out.push('', paint('refused', `${MARK.refused} ${say('update.refused_title')}`));
    for (const i of refused) out.push(...i.lines.map((l) => '  ' + l.replace(/^- /, '')));
  }
  // What waits for the person: last, where the eye lands, set apart, each with why and what answers it.
  const held = v.items.filter((i) => i.kind.startsWith('held_') && i.kind !== 'held_pin');
  if (held.length) {
    const block = [paint('attention', paint('bold', `${MARK.attention} ${say('update.waiting', { n: held.length })}`)), ''];
    for (const i of held) {
      const at = { name: i.name, from: i.from, to: i.to };
      block.push(paint('bold', say('update.held_title', at)));
      const why = i.kind === 'held_flagged' ? [] : [say(`update.why.${i.kind}`, at)];
      for (const f of i.flags) if (!why.includes(reasons(s, [f]))) why.push(reasons(s, [f]));
      if (i.kind === 'held_flagged' && !i.flags.length) why.push(say('update.why.held_flagged', at));
      const bullet = m.kind === 'terminal' ? '  • ' : '- ';
      for (const w of why) block.push(bullet + w);
      if (m.commands) block.push('', `  ${say('update.look', at)}`, `  ${say('update.take', at)}`, paint('dim', `  ${say('update.stays', at)}`), '');
      else block.push('', say('update.stays_reply', at), say('update.look_reply', at), '');
    }
    while (block.at(-1) === '') block.pop();
    // One blank line before the box, not two when nothing was listed above it (review V4.6).
    if (out.at(-1) !== '') out.push('');
    out.push(...m.callout(block));
  }
  return out.join('\n');
}

function publish({ say, m }: Ctx, v: PublishView | undefined): string | undefined {
  if (!v) return undefined;
  const { paint } = m;
  if (v.stage === 'published') return [`${paint('ok', MARK.ok)} ${paint('bold', say('publish.published', v))}`, paint('dim', say('publish.published_next'))].join('\n');
  const title = v.latest === 0 ? say('publish.title_new', v) : say('publish.title', { ...v, changed: v.changed.map((p) => m.text(flagText(p))).join(', ') });
  const rows = [...v.send.map((p) => [m.text(flagText(p)), paint('ok', say('publish.sent'))]), ...v.skipped.map((p) => [paint('dim', m.text(flagText(p))), paint('dim', say('publish.skipped'))])];
  const out = [paint('bold', title), '', ...m.table(header(say, 'publish.columns'), rows)];
  if (v.notes.length) out.push('', ...m.callout([paint('attention', paint('bold', `${MARK.attention} ${say('publish.look')}`)), ...v.notes.map((n) => (m.kind === 'terminal' ? '  • ' : '- ') + n)]));
  if (!m.commands) out.push('', say('publish.stays_reply'));
  return out.join('\n');
}

function install({ s, say, m }: Ctx, v: InstallView | undefined): string | undefined {
  if (!v) return undefined;
  const { paint } = m;
  const at = { name: v.name, version: v.version, from: v.held?.from ?? v.done?.from, to: v.version };
  if (v.held) {
    const over = v.held.from !== undefined;
    const why = v.held.reason === 'flagged' ? [] : [say(`update.why.held_${v.held.reason}`, at)];
    for (const f of v.held.flags) {
      const w = f.kind === 'capability_frontmatter' ? personReason(s, say, f) : reasons(s, [f]);
      if (!why.includes(w)) why.push(w);
    }
    if (!why.length) why.push(say('update.why.held_flagged', at));
    const bullet = m.kind === 'terminal' ? '  • ' : '- ';
    const block = [paint('attention', paint('bold', `${MARK.attention} ${say(over ? 'install.held_title_over' : 'install.held_title', at)}`)), '', ...why.map((w) => bullet + w), ''];
    if (m.commands) block.push(`  ${say('install.see', at)}`, `  ${say('install.take', { command: v.held.command })}`, paint('dim', `  ${say(over ? 'install.stays_over' : 'install.stays', at)}`));
    else block.push(say(over ? 'install.stays_reply_over' : 'install.stays_reply', at), say('update.look_reply', at));
    return m.callout(block).join('\n');
  }
  const d = v.done!;
  const doneWords = d.from === undefined ? 'install.done' : d.from > v.version ? 'install.done_older' : 'install.done_over';
  const out = [`${paint('ok', MARK.ok)} ${paint('bold', say(doneWords, at))}`, paint('dim', say('install.where', { path: m.text(d.path), policy: d.policy_words }))];
  if (d.older) out.push(paint('newer', `${MARK.newer} ${say(m.commands ? 'install.older' : 'install.older_reply', { name: v.name, latest: d.latest })}`));
  if (d.from === undefined) out.push('', say(d.new_folder ? 'install.live_new_folder' : 'install.live', at));
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
    ? paint('dim', `${MARK.partial} ${say('search.partial', { query })}`)
    : r.ranking === 'none'
      ? say(r.next_cursor || first < r.catalog_size ? 'search.header_page' : 'search.header_all', { total: r.catalog_size, first: 1, last: first })
      : say('search.header', { count: r.total_matches, total: r.catalog_size, query });
  const out = [paint('bold', title), ''];
  if (m.kind === 'markdown') {
    // A table the person scans: one row per skill, what it does in its own words.
    const rows = r.results.map((c) => [paint('bold', c.name), `v${c.latest_version}`, m.text(oneLine(c.publisher)), ...(partial ? [m.text(c.matched_words.join(', '))] : []), m.text(oneLine(c.description))]);
    out.push(...m.table(header(say, partial ? 'search.columns_partial' : 'search.columns'), rows));
    return out.join('\n');
  }
  for (const c of r.results) {
    const meta = [`v${c.latest_version}`, oneLine(c.publisher), ...(c.tags.length ? [c.tags.map(oneLine).join(', ')] : [])].join(' · ');
    out.push(`  ${paint('bold', c.name)}  ${paint('dim', meta)}`);
    if (partial) out.push(`    ${paint('dim', say('search.shares', { words: c.matched_words.join(', ') }))}`);
    out.push(`    ${oneLine(c.description)}`, '');
  }
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
  out.push('', paint('dim', item.version === item.latest_version ? say('read.next', { name: item.name }) : say('read.next_version', { name: item.name, version: item.version, latest: item.latest_version })));
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

// The most lines of one file's change a view shows; the rest is a command away (review V3.3).
const DIFF_LINES = 40;

/** A risk flag's reason as the person reads it: a grant in the front matter in words, without the field's name. */
function personReason(s: Words, say: Ctx['say'], f: DiffResult['risk_flags'][number]): string {
  if (f.kind === 'capability_frontmatter' && f.field === 'allowed-tools') {
    const v = (x: unknown) => (x === null || x === undefined ? say('diff.none') : Array.isArray(x) ? x.map(String).join(', ') : String(x));
    const how = f.from === null ? 'added' : f.to === null ? 'removed' : 'changed';
    return say(`diff.tools.${how}`, { from: flagText(v(f.from)), to: flagText(v(f.to)) });
  }
  return reasons(s, [f]);
}

function diff({ s, say, m }: Ctx, r: DiffResult): string {
  const { paint } = m;
  const at = { name: r.name, from: r.from, to: r.to };
  if (r.files.length === 0 && !r.publisher_changed) return say('diff.same', at);
  const out = [paint('bold', say('diff.header', { ...at, n: r.files.length })), ''];
  const bullet = m.kind === 'terminal' ? '  • ' : '- ';
  const why = [...new Set(r.risk_flags.map((f) => personReason(s, say, f)))];
  if (why.length) out.push(...m.callout([paint('attention', paint('bold', `${MARK.attention} ${say('diff.runs')}`)), ...why.map((w) => bullet + w)]), '');
  else out.push(`${paint('ok', MARK.ok)} ${say('diff.runs_no')}`, '');
  const tone = { added: 'added', changed: 'bold', removed: 'removed' } as const;
  const rows = r.files.map((f) => {
    const kind = f.flags.executable ? 'executable' : f.flags.script ? 'script' : f.flags.binary ? 'binary' : undefined;
    return [paint(tone[f.status], say(`diff.status.${f.status}`)), m.text(flagText(f.path)), kind ? paint(f.flags.binary ? 'dim' : 'attention', say(`diff.kind.${kind}`)) : ''];
  });
  out.push(...m.table(header(say, 'diff.columns'), rows));
  const show = (v: unknown) => (v === null ? say('diff.none') : flagText(Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)));
  // A field the box already explains isn't repeated under the table (review V3.8).
  const explained = new Set(r.risk_flags.filter((f) => f.kind === 'capability_frontmatter').map((f) => f.field));
  for (const c of r.frontmatter_changes.filter((c) => !explained.has(c.field))) out.push(`${bullet}${m.text(say('diff.frontmatter', { field: flagText(c.field), from: show(c.from), to: show(c.to) }))}`);
  const publisher = r.risk_flags.find((f) => f.kind === 'new_publisher');
  if (publisher) out.push(`${bullet}${m.text(say('diff.publisher', { from: flagText(String(publisher.from)), to: flagText(String(publisher.to)) }))}`);
  // The changed lines are the publishers' text, apart from ours; in a terminal coloured by + and -.
  for (const f of r.files.filter((x) => x.unified)) {
    const all = fenced(f.unified!.trimEnd()).split('\n');
    const text = all.slice(0, DIFF_LINES).join('\n');
    const shown = m.kind === 'terminal'
      ? text.split('\n').map((l) => (l.startsWith('+') && !l.startsWith('+++') ? paint('added', l) : l.startsWith('-') && !l.startsWith('---') ? paint('removed', l) : l.startsWith('@@') ? paint('newer', l) : paint('dim', l))).join('\n')
      : text;
    out.push('', ...m.quoted(shown, 'diff'));
    if (all.length > DIFF_LINES) out.push(paint('dim', say(m.commands ? 'diff.more_lines' : 'diff.more_lines_reply', { ...at, n: all.length - DIFF_LINES })));
  }
  return out.join('\n');
}

// Errors: the sentence without its code, and what the person can do next: a command to type in a terminal, words in a
// reply. In a reply only the errors with words of their own here have a view; in a terminal the rest keep their text,
// only without the leading code (a person has no use for "not_found:").
function error({ s, say, m }: Ctx, a: Answer): string | undefined {
  const { paint } = m;
  const e = a.error!;
  const d = e.data as Record<string, unknown>;
  const mark = paint('refused', MARK.refused);
  // The first line marked, the rest under it: indented in a terminal, paragraphs in a reply.
  const shown = (first: string, ...rest: string[]) => (m.kind === 'terminal' ? [`${mark} ${first}`, ...rest.map((l) => `  ${l}`)].join('\n') : [`${mark} ${first}`, ...rest].join('\n\n'));
  const next = (line: string) => (m.commands ? [paint('dim', line)] : []);
  if (e.code === 'not_found' && typeof d['name'] === 'string') {
    const name = m.text(oneLine(d['name']));
    // A file or a version the skill doesn't have: the skill is there.
    if (d['path'] !== undefined && d['version'] !== undefined) return shown(say('errors.not_found_path', { name, version: d['version'], path: m.text(flagText(String(d['path']))) }), ...next(say('errors.not_found_path_next', { name })));
    if (d['version'] !== undefined && d['latest'] !== undefined) return shown(say('errors.not_found_version', { name, version: d['version'], latest: d['latest'] }), ...next(say('errors.not_found_version_next', { name })));
    if (d['version'] === undefined && d['path'] === undefined) {
      const names = ((d['suggestions'] as string[] | undefined) ?? []).map((n) => paint('bold', m.text(n))).join(', ');
      const suggest = names ? [say(m.commands ? 'errors.not_found_suggest' : 'errors.not_found_suggest_reply', { names })] : [];
      return shown(say('errors.not_found', { name }), ...suggest, ...next(say('errors.not_found_next')));
    }
  }
  // A name looked up that isn't a skill name ("Release Notes Kit"): the names it likely means.
  if (e.code === 'invalid_name' && Array.isArray(d['suggestions']) && typeof d['name'] === 'string') {
    const names = (d['suggestions'] as string[]).map((n) => paint('bold', m.text(n))).join(', ');
    const suggest = names ? [say(m.commands ? 'errors.not_found_suggest' : 'errors.not_found_suggest_reply', { names })] : [];
    return shown(say('errors.invalid_name', { name: m.text(oneLine(d['name'])) }), ...suggest, ...next(say('errors.not_found_next')));
  }
  // A refused SKILL.md: what it lacks, in the same words as the assistant's, and the fix the person can make.
  const manifest = e.code === 'invalid_manifest' ? d : e.code === 'invalid_name' && d['folder'] !== undefined && d['suggestion'] !== undefined ? { ...d, problem: 'bad_name' } : undefined;
  if (manifest && typeof manifest['folder'] === 'string') {
    const r = manifestRefusal(s, manifest);
    if (r) {
      const file = say('errors.rejected_file', { folder: m.text(oneLine(manifest['folder'].replace(/\/+$/, '').split('/').at(-1) ?? '')) });
      const fix = s.word(`person.errors.rejected_fix.${r.fixKey}`) === undefined ? 'other' : r.fixKey;
      return shown(paint('bold', say('errors.rejected', { file, problem: r.problem })), say(`errors.rejected_fix.${fix}`, r.slots));
    }
  }
  // The catalog itself can't be used: which one, and the setting to check (review V4.3).
  if (e.code === 'catalog_unreachable') return shown(say('errors.unreachable', { catalog: m.text(String(d['catalog'])), detail: m.text(String(d['detail'] ?? '')) }), ...next(say('errors.unreachable_next')));
  if (e.code === 'invalid_request' && d['why'] === 'not_a_catalog') return shown(say('errors.no_catalog', { path: m.text(String(d['path'] ?? '')) }), ...next(say('errors.no_catalog_next')));
  if (m.kind !== 'terminal') return undefined;
  if (e.code === 'not_installed' && typeof d['name'] === 'string') return `${mark} ${say('errors.not_installed', { name: oneLine(d['name']) })}`;
  // The rest keep their text, without the leading code and without the "acting as" line the CLI adds once itself.
  const acting = new RegExp(`\\n?${s.word('acting_as').replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{developer}', '[^\\n]*')}$`);
  return `${mark} ${a.text.replace(acting, '').replace(/^[a-z_]+: /, '')}`;
}

/** The first line before the usage, for a person who typed something the CLI doesn't take. */
export const usageLead = (s: Words) => sayer(s)('usage');

/** The MCP result for an answer: the assistant's words, then the person's view in markdown (when it has one), under the
 *  line that tells the assistant what it is for. */
export function withPersonView(s: Words, m: Medium, op: string, a: Answer, args: Record<string, unknown>): string {
  const shown = personView(s, m, op, a, args);
  return shown === undefined ? a.text : `${a.text}\n\n${sayer(s)('for_person')}\n\n${shown}`;
}
