// SKILL.md: YAML front matter, then a markdown body (contract §4.1, the Agent Skills format).

import { parseDocument } from 'yaml';
import { CatalogError } from '../errors.ts';
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
  if (name.length > NAME_MAX) return `longer than ${NAME_MAX} characters`;
  if (!NAME_RE.test(name)) return 'only lowercase letters, digits and single hyphens, not at either end';
  return null;
}

export function checkName(name: unknown): string {
  const why = nameProblem(name);
  if (why) throw new CatalogError('invalid_name', { name: String(name ?? ''), why });
  return name as string;
}

const FRONT = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

// invalid_manifest {fields}: the front matter fields at fault, or SKILL.md itself when it can't be read at all.
function manifestError(problem: string, fields: string[] = [MANIFEST]): CatalogError {
  return new CatalogError('invalid_manifest', { problem, fields });
}

// Parse the front matter with YAML's core schema: no custom tags (a tag it doesn't know is refused, not ignored),
// no duplicate keys, a mapping at the top.
export function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FRONT.exec(text);
  if (!m) throw manifestError('has no front matter (a --- block at the top)');
  const doc = parseDocument(m[1]!, { schema: 'core', uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    throw manifestError(`front matter is not valid YAML (${(doc.errors[0] ?? doc.warnings[0])!.code})`);
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw manifestError('front matter is not valid YAML');
  }
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw manifestError('front matter is not a mapping of keys');
  return { frontmatter: value as Record<string, unknown>, body: m[2]! };
}

// Checks SKILL.md in a tree against §4.1, and that its name is the catalog name when one is given.
export function checkManifest(files: readonly TreeFile[], catalogName?: string): Manifest {
  const file = files.find((f) => f.path === MANIFEST);
  if (!file) throw manifestError('is missing (the folder needs a SKILL.md at its top)', ['SKILL.md']);
  if (!isText(file.bytes)) throw manifestError('is not UTF-8 text');
  const { frontmatter, body } = parseFrontmatter(decodeText(file.bytes));

  const missing: string[] = [];
  const name = frontmatter['name'];
  if (name === undefined || name === null || name === '') missing.push('name');
  const description = frontmatter['description'];
  let descriptionProblem = '';
  if (description === undefined || description === null || description === '') missing.push('description');
  else if (typeof description !== 'string') descriptionProblem = 'description is not text';
  else if ([...description].length > DESCRIPTION_MAX) descriptionProblem = `description is longer than ${DESCRIPTION_MAX} characters`;
  else if (/[<>]/.test(description)) descriptionProblem = 'description has < or >';
  if (body.trim() === '') missing.push('body');
  if (missing.length > 0) throw manifestError(`is missing ${missing.join(', ')}`, missing);
  if (descriptionProblem) throw manifestError(descriptionProblem, ['description']);

  checkName(typeof name === 'string' ? name : String(name));
  if (catalogName !== undefined && name !== catalogName) {
    throw new CatalogError('invalid_name', { name: catalogName, why: `SKILL.md says its name is ${String(name)}` });
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
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw manifestError('metadata is not a mapping of keys', ['metadata']);
  const raw = (metadata as Record<string, unknown>)['tags'];
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') throw manifestError('metadata.tags is not one comma-separated string', ['metadata.tags']);
  const tags = [...new Set(raw.split(',').map((t) => t.trim()))];
  const bad = tags.find((t) => !TAG_RE.test(t));
  if (bad !== undefined) throw manifestError(`tag "${bad}" is not 1-32 lowercase letters, digits and hyphens`, ['metadata.tags']);
  if (tags.length > MAX_TAGS) throw manifestError(`has ${tags.length} tags; at most ${MAX_TAGS}`, ['metadata.tags']);
  return tags;
}
