// Results and errors as the words an assistant (or a person at the CLI) reads: one renderer for the MCP text
// content and the CLI's stdout. Every sentence comes from the surface; a result the surface has no words for yet
// is listed in WORD_GAPS and rendered as its data, never as hand-written prose.

import type { ReadEntry, ReadItem, SearchResult } from './catalog.ts';
import { CatalogError } from './errors.ts';
import type { Surface } from './surface.ts';

// Words the agent-facing surface doesn't have yet (asked for). A test fails when one of them appears in the surface,
// so each is wired as soon as it lands.
export const WORD_GAPS = [
  'search.partial',
  'get.latest_mark',
  'versions',
  'diff',
  'errors.not_owner',
  'errors.invalid_name',
  'errors.invalid_path',
  'errors.too_large',
  'errors.invalid_request',
  'errors.conflict',
  'errors.unauthenticated',
  'errors.forbidden',
  'errors.internal_error',
] as const;

function asData(code: string, data: Record<string, unknown>): string {
  return `${code}: ` + Object.entries(data).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ');
}

export function renderSearch(s: Surface, r: SearchResult, query: string, offset = 0): string {
  if (!s.guided) return JSON.stringify(r);
  const w = s.word('search');
  const ranking = w.ranking[r.ranking];
  if (r.results.length === 0) {
    const hint = w.empty_hint[r.ranking === 'lexical' ? 'lexical' : 'other'];
    return s.format(w.empty, { query, ranking, total: r.catalog_size, hint });
  }
  const lines = [
    r.ranking === 'none'
      ? s.format(w.header_all, { total: r.catalog_size, first: offset + 1, last: offset + r.results.length })
      : s.format(w.header, { count: r.total_matches, total: r.catalog_size, query, ranking }),
    ...r.results.map((c) =>
      s.format(w.card, { name: c.name, version: c.latest_version, publisher: c.publisher, tags: c.tags.join(', ') || 'none', description: c.description }),
    ),
  ];
  if (r.next_cursor) lines.push(s.format(w.more, { cursor: r.next_cursor }));
  lines.push(s.format(w.next));
  return lines.join('\n');
}

function renderItem(s: Surface, item: ReadItem, body: string): string {
  const w = s.word('get');
  const lines = [
    s.format(w.header, { name: item.name, version: item.version, latest_mark: '', publisher: item.publisher, published_at: item.published_at }),
    s.format(w.data_note, { publisher: item.publisher }),
    w.fence[0],
    body.trimEnd(),
    w.fence[1],
  ];
  if (item.files) lines.push(s.format(w.files, { files: item.files.map((f) => `${f.path} (${f.size} B)`).join(', ') }));
  // Other text files get the same fence as SKILL.md, with their own path.
  for (const f of item.files ?? []) {
    if (f.content !== undefined && f.path !== 'SKILL.md') lines.push(w.fence[0].replace('SKILL.md', f.path), f.content.trimEnd(), w.fence[1].replace('SKILL.md', f.path));
  }
  lines.push(s.format(w.next, { name: item.name }));
  return lines.join('\n');
}

// `skillMd` gives each item's SKILL.md as published (the face reads it with include=files or from the manifest).
export function renderRead(s: Surface, r: { skills: ReadEntry[] }, skillMd: (item: ReadItem) => string): string {
  if (!s.guided) return JSON.stringify(r);
  return r.skills
    .map((e) => ('error' in e ? renderError(s, new CatalogError(e.error.code as any, Object.fromEntries(Object.entries(e.error).filter(([k]) => k !== 'code')))) : renderItem(s, e, skillMd(e))))
    .join('\n\n');
}

export function renderError(s: Surface, e: CatalogError): string {
  if (!s.guided) return JSON.stringify({ error: e.toJSON() });
  const w = s.word('errors');
  const d = e.data;
  switch (e.code) {
    case 'not_found': {
      const names = (d['suggestions'] as string[] | undefined) ?? [];
      const suggest = names.length ? s.format(w.not_found_suggest, { names: names.join(', ') }) : '';
      const name = d['version'] !== undefined ? `${d['name']} v${d['version']}` : String(d['name'] ?? d['fingerprint']);
      return s.format(w.not_found, { name, suggest }) + '\n' + s.format(w.not_found_next);
    }
    case 'invalid_manifest': {
      const fields = (d['fields'] as string[] | undefined) ?? [];
      const fix = fields.includes('SKILL.md') ? w.invalid_manifest_fix.missing : fields.includes('description') ? w.invalid_manifest_fix.description : fields.includes('name') ? w.invalid_manifest_fix.missing : undefined;
      if (fix && d['folder'] !== undefined) return s.format(w.invalid_manifest, { folder: d['folder'], problem: d['problem'], fix });
      return asData(e.code, d);
    }
    default: {
      const t = w[e.code];
      if (typeof t === 'string') {
        try {
          return s.format(t, d);
        } catch {
          return asData(e.code, d);
        }
      }
      return asData(e.code, d);
    }
  }
}
