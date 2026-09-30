// Results and errors as the words an assistant (or a person at the CLI) reads: one renderer for the MCP text
// content and the CLI's stdout. Every sentence comes from the words file; a result the words file has no words for yet
// is listed in WORD_GAPS and rendered as its data, never as hand-written prose.

import { stringify } from 'yaml';
import { cursorOffset, type DiffResult, type InlineBudget, type ReadItem, type ReadResult, type SearchInput, type SearchResult, type VersionsResult } from './catalog.ts';
import { CatalogError } from './errors.ts';
import type { Ids } from './ports.ts';
import { MANIFEST, flagText, oneLine, type RiskFlag } from './skill-tree/index.ts';
import type { Words } from './words-file.ts';

// Words the words file doesn't have yet (asked for). A test fails when one of them appears in the words file,
// so each is wired as soon as it lands.
export const WORD_GAPS: readonly string[] = [];

function asData(code: string, data: Record<string, unknown>): string {
  return `${code}: ` + Object.entries(data).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ');
}

const list = (xs: readonly string[]) => xs.join(', ');

// Text inside a fence can't drive a terminal (contract §5.2): every C0 control but TAB and LF, DEL, every C1 control and
// a CR not directly before an LF is shown as \u{xxxx}. Only what's shown changes; the data keeps its bytes.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\r(?!\n)/g;
export const fenced = (text: string) => text.replace(CONTROLS, (c) => `\\u{${c.charCodeAt(0).toString(16).padStart(4, '0')}}`);

// Publisher text shown outside a fence can't forge the product's own lines (contract §5.2): a one-line field (a
// description, a message, a developer's name) shows a line break or control character as a space, and flag text (a
// path, a key's old and new values, the detail) is escaped and cut (skill-tree's flagText, also applied here to
// anything shown from a flag or a front matter change).

// A timestamp shows as its day (UTC), in the words file's date words; the data keeps the full ISO time.
const day = (s: Words, iso: string) => {
  const [yyyy, mm, dd] = iso.slice(0, 10).split('-');
  return s.format(s.word('date'), { yyyy, mm, dd });
};

// `req` is the search as asked: its words and, for a later page, its cursor (read here, so no face parses one).
export function renderSearch(s: Words, r: SearchResult, req: SearchInput): string {
  if (!s.guided) return JSON.stringify(r);
  const query = req.query ?? '';
  const offset = cursorOffset(req.cursor);
  const w = s.word('search');
  const ranking = w.ranking[r.ranking];
  // An empty catalog: another search can't find anything, so it says so rather than suggesting other words.
  if (r.results.length === 0 && r.catalog_size === 0 && typeof w.empty_catalog === 'string') return s.format(w.empty_catalog, { query });
  if (r.results.length === 0) {
    const hint = w.empty_hint[r.ranking === 'lexical' ? 'lexical' : 'other'];
    return s.format(w.empty, { query, ranking, total: r.catalog_size, hint });
  }
  const tags = (t: string[]) => list(t) || w.no_tags;
  let lines: string[];
  if (r.match === 'partial') {
    // Nothing matched every word: the closest cards, each with the words it shares, never presented as a fit.
    lines = [
      s.format(w.partial_header, { query, ranking }),
      ...r.results.map((c) => s.format(w.partial_card, { name: c.name, version: c.latest_version, publisher: oneLine(c.publisher), shared: list(c.matched_words), description: oneLine(c.description) })),
    ];
  } else {
    lines = [
      r.ranking === 'none'
        ? s.format(w.header_all, { total: r.catalog_size, first: offset + 1, last: offset + r.results.length })
        : s.format(w.header, { count: r.total_matches, total: r.catalog_size, query, ranking }),
      ...r.results.map((c) => s.format(w.card, { name: c.name, version: c.latest_version, publisher: oneLine(c.publisher), tags: tags(c.tags), description: oneLine(c.description) })),
    ];
  }
  if (r.next_cursor) lines.push(s.format(w.more, { cursor: r.next_cursor }));
  lines.push(s.format(r.match === 'partial' ? w.partial_next : w.next));
  return lines.join('\n');
}

// A path shown outside a fence is JSON-quoted, so a publisher's file name reads as a name and nothing else.
const quoted = (path: string) => JSON.stringify(path);

// A skill's text sits between markers that carry a token made for this read (contract §5.2), so text inside can't
// close the fence by planting a marker in any spelling: it can't know the token. Everything shown comes from the
// read's own result, so a face can't show more than the core inlined (§2's budget): the fence holds the front matter
// and the body when the core inlined it; a skill whose body was left out shows no fence at all.
function renderItem(s: Words, item: ReadItem, token: string, budget: InlineBudget): string {
  const w = s.word('get');
  const size = (bytes: number) => s.format(w.size, { kb: Math.ceil(bytes / 1024) });
  const publisher = oneLine(item.publisher);
  const lines = [s.format(w.header, { name: item.name, version: item.version, latest_mark: item.version === item.latest_version ? w.latest_mark.latest : s.format(w.latest_mark.older, { latest: item.latest_version }), publisher, published_at: day(s, item.published_at) })];
  const body = item.manifest.body;
  const shown = body !== undefined;
  if (shown) {
    const skillMd = skillMdOf(item)!;
    const end = s.format(w.fence[1], { token });
    lines.push(s.format(w.data_note, { publisher, end }), s.format(w.fence[0], { token }), fenced(skillMd.trimEnd()), end);
  }
  if (item.files) lines.push(s.format(w.files, { files: list(item.files.map((f) => `${quoted(f.path)} (${f.size} B)`)) }));
  for (const f of item.files ?? []) {
    if (f.content !== undefined && f.path !== MANIFEST) {
      lines.push(s.format(w.file_fence[0], { path: quoted(f.path), token }), fenced(f.content.trimEnd()), s.format(w.file_fence[1], { path: quoted(f.path), token }));
    }
  }
  // What was left out. A body is read with paths ["SKILL.md"] (one path is read whole, whatever its size); a file
  // bigger than the whole budget only on its own; the rest with paths[].
  if (item.manifest.body_omitted) lines.push(s.format(w.body_omitted, { used: size(budget.used), limit: size(budget.limit), name: item.name }));
  const left = (item.files ?? []).filter((f) => f.content_omitted && !(shown && f.path === MANIFEST));
  const tooBig = left.filter((f) => f.size > budget.limit).map((f) => f.path);
  const omitted = left.filter((f) => f.size <= budget.limit).map((f) => f.path);
  if (omitted.length) lines.push(s.format(w.omitted, { used: size(budget.used), limit: size(budget.limit), files: list(omitted.map(quoted)), name: item.name }));
  if (tooBig.length) lines.push(s.format(w.too_big, { limit: size(budget.limit), files: list(tooBig.map(quoted)), name: item.name }));
  lines.push(s.format(w.next, { name: item.name }));
  return lines.join('\n');
}

/** A read's SKILL.md as its text (front matter, then body), when the read carries its body; control characters are
 *  still the caller's to show escaped (fenced). */
export const skillMdOf = (item: ReadItem): string | undefined =>
  item.manifest.body === undefined ? undefined : `---\n${stringify(item.manifest.frontmatter, { lineWidth: 0 })}---\n${item.manifest.body}`;

// `ids` makes the read's fence token (the injected Ids, so tests can fix it).
export function renderRead(s: Words, r: ReadResult, ids: Ids): string {
  if (!s.guided) return JSON.stringify(r);
  const token = ids.next();
  return r.skills
    .map((e) => {
      if (!('error' in e)) return renderItem(s, e, token, r.inline_budget);
      const { code, ...data } = e.error;
      return renderError(s, new CatalogError(code as CatalogError['code'], data));
    })
    .join('\n\n');
}

export function renderVersions(s: Words, r: VersionsResult): string {
  if (!s.guided) return JSON.stringify(r);
  const w = s.word('versions');
  const lines = [
    s.format(w.header, { name: r.name, n: r.latest, latest: r.latest }),
    ...r.versions.map((v) => s.format(w.line, { version: v.version, published_at: day(s, v.published_at), publisher: oneLine(v.publisher), message: oneLine(v.message) || w.no_message })),
  ];
  if (r.next_cursor) lines.push(s.format(w.more, { cursor: r.next_cursor }));
  if (r.latest > 1) lines.push(s.format(w.next));
  return lines.join('\n');
}

// One sentence per risk flag, from the update gate's reasons.
export function reasons(s: Words, flags: readonly RiskFlag[]): string {
  const w = s.word('update.reason');
  return flags.map((f) => s.format(w[f.kind], { path: flagText(f.path ?? ''), detail: flagText(f.detail), ...(f.line === undefined ? {} : { line: f.line }) })).join('; ');
}

// `ids` makes the fence token for the changed lines, which are the publishers' data, like a read's text (§5.2).
export function renderDiff(s: Words, r: DiffResult, ids: Ids): string {
  if (!s.guided) return JSON.stringify(r);
  const w = s.word('diff');
  if (r.files.length === 0 && !r.publisher_changed) return s.format(w.same, { name: r.name, from: r.from, to: r.to });
  const executes = r.risk_flags.length ? s.format(w.executes_yes, { reasons: reasons(s, r.risk_flags) }) : w.executes_no;
  const lines = [s.format(w.header, { name: r.name, from: r.from, to: r.to, n: r.files.length, executes })];
  for (const f of r.files) {
    const kind = f.flags.executable ? w.kind.executable : f.flags.script ? w.kind.script : f.flags.binary ? w.kind.binary : '';
    lines.push(s.format(w.file, { status: f.status, path: quoted(f.path), kind }));   // a path outside the fence is data: JSON-quoted (§5.2)
  }
  const show = (v: unknown) => (v === null ? w.absent : flagText(Array.isArray(v) ? list(v.map(String)) : typeof v === 'object' ? JSON.stringify(v) : String(v)));
  for (const c of r.frontmatter_changes) lines.push(s.format(w.frontmatter, { field: flagText(c.field), from: show(c.from), to: show(c.to) }));
  const publisher = r.risk_flags.find((f) => f.kind === 'new_publisher');
  if (publisher) lines.push(s.format(w.publisher, { from: flagText(String(publisher.from)), to: flagText(String(publisher.to)) }));
  const hunks = r.files.map((f) => f.unified).filter((u): u is string => !!u);
  if (hunks.length) {
    const token = ids.next();
    const end = s.format(w.fence[1], { token });
    lines.push(w.lines_intro, s.format(w.data_note, { end }), s.format(w.fence[0], { token }), ...hunks.map((u) => fenced(u.trimEnd())), end);
  }
  return lines.join('\n');
}

// A path or name placed in a command the person is told to run (contract §5.2): bare when it's only letters, digits and
// @ % + = : , . / _ - ; otherwise in POSIX single quotes, a ' inside written '\''. So it stays one argument, and nothing
// in it runs.
export function shellQuote(text: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

export function renderError(s: Words, e: CatalogError): string {
  if (!s.guided) return JSON.stringify({ error: e.toJSON() });
  const w = s.word('errors');
  // An error's data can carry a request's or a publisher's text (a path, an owner's name): each shown on one line.
  const clean = (v: unknown): unknown => (typeof v === 'string' ? oneLine(v) : Array.isArray(v) ? v.map(clean) : v);
  const data = Object.fromEntries(Object.entries(e.data).map(([k, v]) => [k, clean(v)]));
  // A reason is a code (why: 'unknown_field'); the words file words it once errors.why exists (a listed gap until then).
  // An unknown field whose name was cut to its first 200 characters (field_cut) is worded as cut.
  const why = data['why'] === 'unknown_field' && data['field_cut'] === true ? 'unknown_field_cut' : data['why'];
  const d: Record<string, unknown> = typeof why === 'string' ? { ...data, why: w.why?.[why] ?? why } : data;
  const fill = (template: string, fields: Record<string, unknown>) => {
    try {
      return s.format(template, fields);
    } catch {
      return asData(e.code, d);
    }
  };
  switch (e.code) {
    case 'not_found': {
      // A token (revoke_token) is named by its id only, never whose it is.
      if (d['id'] !== undefined) return fill(w.not_found_token, d);
      const names = (d['suggestions'] as string[] | undefined) ?? [];
      const suggest = names.length ? s.format(w.not_found_suggest, { names: list(names) }) : '';
      const name = d['version'] !== undefined ? `${d['name']} v${d['version']}` : String(d['name'] ?? d['fingerprint']);
      return s.format(w.not_found, { name, suggest }) + '\n' + s.format(w.not_found_next);
    }
    case 'invalid_manifest': {
      // Problem and fix are worded per problem code; missing fields are worded per field (name, description) when the
      // first missing one has its own words. The folder is known to the machine operation (publish a folder), while a
      // raw publish_version has none and renders as data.
      const code = String(d['problem'] ?? 'missing');
      const first = ((d['fields'] as string[] | undefined) ?? [])[0];
      const key = code === 'missing_fields' && first && w.invalid_manifest_problem?.[first] ? first : code;
      const phrase = w.invalid_manifest_problem?.[key];
      const fix = w.invalid_manifest_fix?.[key];
      if (d['folder'] === undefined || !phrase || !fix) return asData(e.code, d);
      // Two problem phrases have their own slots: the YAML feature in words, and the key at fault (quoted).
      const problem = fill(phrase, {
        feature: w.yaml_feature_words?.[String(d['feature'])] ?? d['feature'],
        field: first === undefined ? undefined : quoted(first),
      });
      return fill(w.invalid_manifest, { folder: d['folder'], problem, fix: fill(fix, { suggestion: d['suggestion'] }) });
    }
    case 'invalid_name': {
      // A bad name in the front matter of a folder being published reads as a manifest problem, with a suggestion.
      if (d['folder'] !== undefined && d['suggestion'] !== undefined) {
        return fill(w.invalid_manifest, { folder: d['folder'], problem: w.invalid_manifest_problem.bad_name, fix: fill(w.invalid_manifest_fix.bad_name, { suggestion: d['suggestion'] }) });
      }
      return fill(w.invalid_name, d);
    }
    case 'not_owner':
      return fill(w.not_owner, { name: d['name'], owners: list((d['owners'] as string[]) ?? []) });
    case 'too_large':
      return fill(w.too_large, { ...d, limit: w.too_large_limit?.[String(d['limit'])] ?? d['limit'] });
    case 'invalid_request':
      // A confirm that didn't come from a preview on this machine has its own sentence: preview again.
      if (e.data['why'] === 'not_a_confirm') return fill(w.invalid_confirm, d);
      return fill(d['limit'] !== undefined ? w.invalid_request_limit : w.invalid_request, d);
    case 'invalid_path':
      // A link, a hard link or a special file in a folder being published: its own sentence proposes a plain copy.
      return fill(e.data['why'] === 'not_regular_file' ? w.invalid_path_not_regular : w.invalid_path, d);
    case 'conflict':
      // A held update or install that changed since the person was told (accept_held_update) has its own sentence.
      if (d['held'] === true) return fill(w.accept_conflict, d);
      return fill(d['folder'] !== undefined ? w.publish_conflict : w.conflict, d);
    case 'name_in_use':
      // A command file (.claude/commands/<name>.md) has its own sentence; a skill's folder name never ends in .md.
      return fill(String(d['path']).endsWith('.md') ? w.name_in_use_command : w.name_in_use, d);
    case 'forbidden':
      // A hosted catalog asked of this local-only version is a setup matter, and a publish on a local page's server
      // started without --publish is the person's choice; neither is a permission.
      if (e.data['why'] === 'hosted_not_available') return fill(w.forbidden_hosted, d);
      // A hosted change made with a token that may only read: the person's matter too, never a token to go looking for.
      if (e.data['why'] === 'read_scope') return fill(w.forbidden_read_scope, d);
      // A person at the limit of live tokens: theirs to revoke some, never the agent's.
      if (e.data['why'] === 'too_many_tokens') return fill(w.forbidden_too_many_tokens, d);
      return e.data['why'] === 'read_only' ? fill(w.forbidden_read_only, d) : fill(w.forbidden, d);
    case 'secret_suspected': {
      const kind = w.secret_kind?.[String(d['kind'])];
      // Its words hold the command that allows the secret for one publish: the folder goes in it shell-quoted.
      const folder = d['folder'] === undefined ? {} : { folder: shellQuote(String(d['folder'])) };
      return kind === undefined ? asData(e.code, d) : fill(w.secret_suspected, { ...d, kind, ...folder });
    }
    case 'internal_error':
      return d['log'] === undefined ? fill(w.internal_error_no_log, d) : fill(w.internal_error, d);
    case 'invalid_local_file': {
      // A damaged lock or config file: what removing it would do depends on which file it is.
      const effect = w.local_file_effect?.[String(d['file'])];
      return effect === undefined ? asData(e.code, d) : fill(w.invalid_local_file, { ...d, effect });
    }
    case 'target_changed': {
      // Whether the folder moved aside is back or sits in staging (named, whatever changed), whether what changed was the
      // temp folder the new copy was being written in, and whether a copy may have gone elsewhere.
      const t = d['staging'] !== undefined ? w.target_changed_staging : d['temp'] === true ? w.target_changed_temp : w.target_changed;
      const base = fill(t, d);
      return d['elsewhere'] === true ? base + fill(w.target_changed_elsewhere, {}) : base;
    }
    case 'target_not_private': {
      // The sentence by what the folder is (the person's home, a project, or a folder inside) and whether it's their own:
      // only their own folder gets a chmod, its path shell-quoted; another's gets another way on.
      const what = d['home'] === true ? 'target_not_private_home' : d['target'] === 'project' ? 'target_not_private_project' : 'target_not_private';
      return fill(w[d['own'] === false ? `${what}_not_own` : what], { ...d, path: shellQuote(String(d['path'])) });
    }
    case 'target_unavailable':
      // The sentence by what couldn't be made (the person's home, a project, or a folder on the way); no command uses the
      // path, so it's shown as it is.
      return fill(w[d['home'] === true ? 'target_unavailable_home' : d['target'] === 'project' ? 'target_unavailable_project' : 'target_unavailable'], d);
    case 'invalid_developer_setting': {
      // A bad developer name from a setting (SKILLS_AS, the MCP server's config, setup's `me`): fix it there.
      const setting = w.developer_setting?.[String(d['setting'])];
      return setting === undefined ? asData(e.code, d) : fill(w.invalid_developer_setting, { setting });
    }
    // With no holder to name (another user's file, a link, anything but a regular file), the file is named instead.
    case 'lock_busy':
      return d['pid'] === null && typeof w.lock_busy_unusable === 'string' ? fill(w.lock_busy_unusable, d) : typeof w.lock_busy === 'string' ? fill(w.lock_busy, d) : asData(e.code, d);
    default: {
      const t = w[e.code];
      return typeof t === 'string' ? fill(t, d) : asData(e.code, d);
    }
  }
}
