// Results and errors as the words an assistant (or a person at the CLI) reads: one renderer for the MCP text
// content and the CLI's stdout. Every sentence comes from the surface; a result the surface has no words for yet
// is listed in WORD_GAPS and rendered as its data, never as hand-written prose.

import { stringify } from 'yaml';
import { cursorOffset, type DiffResult, type InlineBudget, type ReadItem, type ReadResult, type SearchInput, type SearchResult, type VersionsResult } from './catalog.ts';
import { CatalogError } from './errors.ts';
import type { Ids } from './ports.ts';
import { MANIFEST, type RiskFlag } from './skill-tree/index.ts';
import type { Surface } from './surface.ts';

// Words the agent-facing surface doesn't have yet (asked for). A test fails when one of them appears in the surface,
// so each is wired as soon as it lands.
export const WORD_GAPS: readonly string[] = [];

function asData(code: string, data: Record<string, unknown>): string {
  return `${code}: ` + Object.entries(data).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ');
}

const list = (xs: readonly string[]) => xs.join(', ');

// `req` is the search as asked: its words and, for a later page, its cursor (read here, so no face parses one).
export function renderSearch(s: Surface, r: SearchResult, req: SearchInput): string {
  if (!s.guided) return JSON.stringify(r);
  const query = req.query ?? '';
  const offset = cursorOffset(req.cursor);
  const w = s.word('search');
  const ranking = w.ranking[r.ranking];
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
      ...r.results.map((c) => s.format(w.partial_card, { name: c.name, version: c.latest_version, publisher: c.publisher, shared: list(c.matched_words), description: c.description })),
    ];
  } else {
    lines = [
      r.ranking === 'none'
        ? s.format(w.header_all, { total: r.catalog_size, first: offset + 1, last: offset + r.results.length })
        : s.format(w.header, { count: r.total_matches, total: r.catalog_size, query, ranking }),
      ...r.results.map((c) => s.format(w.card, { name: c.name, version: c.latest_version, publisher: c.publisher, tags: tags(c.tags), description: c.description })),
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
function renderItem(s: Surface, item: ReadItem, token: string, budget: InlineBudget): string {
  const w = s.word('get');
  const size = (bytes: number) => s.format(w.size, { kb: Math.ceil(bytes / 1024) });
  const lines = [s.format(w.header, { name: item.name, version: item.version, latest_mark: item.version === item.latest_version ? w.latest_mark.latest : s.format(w.latest_mark.older, { latest: item.latest_version }), publisher: item.publisher, published_at: item.published_at })];
  const body = item.manifest.body;
  const shown = body !== undefined;
  if (shown) {
    const skillMd = `---\n${stringify(item.manifest.frontmatter, { lineWidth: 0 })}---\n${body}`;
    lines.push(s.format(w.data_note, { publisher: item.publisher }), s.format(w.fence[0], { token }), skillMd.trimEnd(), s.format(w.fence[1], { token }));
  }
  if (item.files) lines.push(s.format(w.files, { files: list(item.files.map((f) => `${quoted(f.path)} (${f.size} B)`)) }));
  for (const f of item.files ?? []) {
    if (f.content !== undefined && f.path !== MANIFEST) {
      lines.push(s.format(w.file_fence[0], { path: quoted(f.path), token }), f.content.trimEnd(), s.format(w.file_fence[1], { path: quoted(f.path), token }));
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

// `ids` makes the read's fence token (the injected Ids, so tests can fix it).
export function renderRead(s: Surface, r: ReadResult, ids: Ids): string {
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

export function renderVersions(s: Surface, r: VersionsResult): string {
  if (!s.guided) return JSON.stringify(r);
  const w = s.word('versions');
  const lines = [
    s.format(w.header, { name: r.name, n: r.latest, latest: r.latest }),
    ...r.versions.map((v) => s.format(w.line, { version: v.version, published_at: v.published_at, publisher: v.publisher, message: v.message || w.no_message })),
  ];
  if (r.next_cursor) lines.push(s.format(w.more, { cursor: r.next_cursor }));
  if (r.latest > 1) lines.push(s.format(w.next));
  return lines.join('\n');
}

// One sentence per risk flag, from the update gate's reasons.
export function reasons(s: Surface, flags: readonly RiskFlag[]): string {
  const w = s.word('update.reason');
  return flags.map((f) => s.format(w[f.kind], { path: f.path ?? '', detail: f.detail })).join('; ');
}

export function renderDiff(s: Surface, r: DiffResult): string {
  if (!s.guided) return JSON.stringify(r);
  const w = s.word('diff');
  if (r.files.length === 0 && !r.publisher_changed) return s.format(w.same, { name: r.name, from: r.from, to: r.to });
  const executes = r.risk_flags.length ? s.format(w.executes_yes, { reasons: reasons(s, r.risk_flags) }) : w.executes_no;
  const lines = [s.format(w.header, { name: r.name, from: r.from, to: r.to, n: r.files.length, executes })];
  for (const f of r.files) {
    const kind = f.flags.executable ? w.kind.executable : f.flags.script ? w.kind.script : f.flags.binary ? w.kind.binary : '';
    lines.push(s.format(w.file, { status: f.status, path: f.path, kind }));
  }
  const show = (v: unknown) => (v === null ? w.absent : Array.isArray(v) ? list(v.map(String)) : typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const c of r.frontmatter_changes) lines.push(s.format(w.frontmatter, { field: c.field, from: show(c.from), to: show(c.to) }));
  const publisher = r.risk_flags.find((f) => f.kind === 'new_publisher');
  if (publisher) {
    const { from, to } = publisher;
    lines.push(s.format(w.publisher, { from, to }));
  }
  const hunks = r.files.map((f) => f.unified).filter((u): u is string => !!u);
  if (hunks.length) lines.push(w.lines_intro, ...hunks.map((u) => u.trimEnd()));
  return lines.join('\n');
}

export function renderError(s: Surface, e: CatalogError): string {
  if (!s.guided) return JSON.stringify({ error: e.toJSON() });
  const w = s.word('errors');
  // A reason is a code (why: 'unknown_field'); the surface words it once errors.why exists (a listed gap until then).
  const d: Record<string, unknown> = typeof e.data['why'] === 'string' ? { ...e.data, why: w.why?.[e.data['why'] as string] ?? e.data['why'] } : e.data;
  const fill = (template: string, fields: Record<string, unknown>) => {
    try {
      return s.format(template, fields);
    } catch {
      return asData(e.code, d);
    }
  };
  switch (e.code) {
    case 'not_found': {
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
      return fill(d['limit'] !== undefined ? w.invalid_request_limit : w.invalid_request, d);
    case 'conflict':
      return fill(d['folder'] !== undefined ? w.publish_conflict : w.conflict, d);
    case 'forbidden':
      // A hosted catalog asked of this local-only version is a setup matter, not a permission.
      return e.data['why'] === 'hosted_not_available' ? fill(w.forbidden_hosted, d) : fill(w.forbidden, d);
    case 'secret_suspected': {
      const kind = w.secret_kind?.[String(d['kind'])];
      return kind === undefined ? asData(e.code, d) : fill(w.secret_suspected, { ...d, kind });
    }
    case 'internal_error':
      return d['log'] === undefined ? fill(w.internal_error_no_log, d) : fill(w.internal_error, d);
    default: {
      const t = w[e.code];
      return typeof t === 'string' ? fill(t, d) : asData(e.code, d);
    }
  }
}
