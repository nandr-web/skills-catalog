// SKILL.md: YAML front matter, then a markdown body (contract §4.1, the Agent Skills format).

import { parseDocument } from 'yaml';
import { CatalogError } from './errors.ts';
import { decodeText, isText, type TreeFile } from './tree.ts';

export const MANIFEST = 'SKILL.md';
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;

export interface Manifest {
  frontmatter: Record<string, unknown>;
  body: string;
  name: string;
  description: string;
  tags: string[];
}

// Returns why a name is not a skill name, or null when it is one.
export function nameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name === '') return 'empty';
  if (name.length > NAME_MAX) return 'too_long';
  if (!NAME_RE.test(name)) return 'bad_characters';
  return null;
}

export function checkName(name: unknown): string {
  const why = nameProblem(name);
  if (why) throw new CatalogError('invalid_name', { name: String(name ?? ''), why });
  return name as string;
}

const FRONT = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

// invalid_manifest {fields, problem}: the front matter fields at fault (or SKILL.md itself when it can't be read at
// all), and the problem as a code; the words for each are in the agent-facing surface.
export type ManifestProblem =
  | 'missing'
  | 'not_utf8'
  | 'no_front_matter'
  | 'invalid_yaml'
  | 'front_matter_not_a_mapping'
  | 'missing_fields'
  | 'description_not_text'
  | 'description_too_long'
  | 'description_angle_brackets'
  | 'metadata_not_a_mapping'
  | 'tags_not_a_string'
  | 'bad_tag'
  | 'too_many_tags';

function manifestError(problem: ManifestProblem, fields: string[] = [MANIFEST], extra: Record<string, unknown> = {}): CatalogError {
  return new CatalogError('invalid_manifest', { problem, fields, ...extra });
}

// Parse the front matter with YAML's core schema: no custom tags (a tag it doesn't know is refused, not ignored),
// no duplicate keys, a mapping at the top.
export function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FRONT.exec(text);
  if (!m) throw manifestError('no_front_matter');
  const doc = parseDocument(m[1]!, { schema: 'core', uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    throw manifestError('invalid_yaml', undefined, { yaml: (doc.errors[0] ?? doc.warnings[0])!.code });
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw manifestError('invalid_yaml');
  }
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw manifestError('front_matter_not_a_mapping');
  return { frontmatter: value as Record<string, unknown>, body: m[2]! };
}

// Checks SKILL.md in a tree against §4.1, and that its name is the catalog name when one is given.
export function checkManifest(files: readonly TreeFile[], catalogName?: string): Manifest {
  const file = files.find((f) => f.path === MANIFEST);
  if (!file) throw manifestError('missing', ['SKILL.md']);
  if (!isText(file.bytes)) throw manifestError('not_utf8');
  const { frontmatter, body } = parseFrontmatter(decodeText(file.bytes));

  const missing: string[] = [];
  const name = frontmatter['name'];
  if (name === undefined || name === null || name === '') missing.push('name');
  const description = frontmatter['description'];
  let descriptionProblem: ManifestProblem | undefined;
  if (description === undefined || description === null || description === '') missing.push('description');
  else if (typeof description !== 'string') descriptionProblem = 'description_not_text';
  else if ([...description].length > DESCRIPTION_MAX) descriptionProblem = 'description_too_long';
  else if (/[<>]/.test(description)) descriptionProblem = 'description_angle_brackets';
  if (body.trim() === '') missing.push('body');
  if (missing.length > 0) throw manifestError('missing_fields', missing);
  if (descriptionProblem) throw manifestError(descriptionProblem, ['description']);

  checkName(typeof name === 'string' ? name : String(name));
  if (catalogName !== undefined && name !== catalogName) {
    throw new CatalogError('invalid_name', { name: catalogName, why: 'differs_from_front_matter', front_matter_name: String(name) });
  }
  return { frontmatter, body, name: name as string, description: description as string, tags: tagsOf(frontmatter) };
}

export const MAX_TAGS = 10;
const TAG_RE = /^[a-z0-9-]{1,32}$/;

// Tags live in the Agent Skills spec's extension point, `metadata` (string values only), as one comma-separated
// string: `metadata: {tags: "docs, release"}` (contract §4.1). Up to 10, each 1-32 lowercase letters, digits and
// hyphens; duplicates dropped, order kept; none is fine.
export function tagsOf(frontmatter: Record<string, unknown>): string[] {
  const metadata = frontmatter['metadata'];
  if (metadata === undefined || metadata === null) return [];
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw manifestError('metadata_not_a_mapping', ['metadata']);
  const raw = (metadata as Record<string, unknown>)['tags'];
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') throw manifestError('tags_not_a_string', ['metadata.tags']);
  const tags = [...new Set(raw.split(',').map((t) => t.trim()))];
  const bad = tags.find((t) => !TAG_RE.test(t));
  if (bad !== undefined) throw manifestError('bad_tag', ['metadata.tags'], { tag: bad });
  if (tags.length > MAX_TAGS) throw manifestError('too_many_tags', ['metadata.tags'], { limit: MAX_TAGS, value: tags.length });
  return tags;
}
