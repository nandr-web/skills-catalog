// SKILL.md: YAML front matter, then a markdown body (contract §4.1, the Agent Skills format).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, visit, type Document } from 'yaml';
import { CatalogError } from './errors.ts';
import { decodeText, isText, type TreeFile } from './tree.ts';

export const MANIFEST = 'SKILL.md';
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;

// One-line fields (a description, a version's message, a developer's name) reach an assistant outside any fence, so
// a line break could forge a line shaped like the product's own guidance (contract §4.1, §5.2): no line break (\r,
// \n, U+2028, U+2029) and no control character (C0, tab included; DEL; C1). Publish refuses them; every face shows
// one with a space instead, for anything stored before the rule.
const LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/u;
export const hasLineBreakOrControl = (text: string): boolean => LINE_BREAK_OR_CONTROL.test(text);
export const oneLine = (text: string): string => text.replace(new RegExp(LINE_BREAK_OR_CONTROL.source, 'gu'), ' ');

export interface Manifest {
  frontmatter: Record<string, unknown>;
  body: string;
  name: string;
  description: string;
  tags: string[];
}

// Names Claude Code already uses (bundled skills, built-in commands and their aliases, and this product's companion
// skill): a skill with one of them would replace a command people trust (contract §4.1). Config, kept with its source
// and date in config/reserved-names.txt.
export const RESERVED_NAMES_FILE = join(import.meta.dirname, '..', '..', 'config', 'reserved-names.txt');

export function readReservedNames(file = RESERVED_NAMES_FILE): ReadonlySet<string> {
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
}

export const RESERVED_NAMES = readReservedNames();

// Returns why a name is not a skill name, or null when it is one.
export function nameProblem(name: unknown, reserved: ReadonlySet<string> = RESERVED_NAMES): string | null {
  if (typeof name !== 'string' || name === '') return 'empty';
  if (name.length > NAME_MAX) return 'too_long';
  if (!NAME_RE.test(name)) return 'bad_characters';
  if (reserved.has(name)) return 'reserved';
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
  | 'control_character'
  | 'description_angle_brackets'
  | 'metadata_not_a_mapping'
  | 'tags_not_a_string'
  | 'bad_tag'
  | 'too_many_tags'
  | 'yaml_feature'
  | 'key_format';

export type YamlFeature = 'merge_key' | 'anchor' | 'alias' | 'tag' | 'duplicate_key' | 'multiple_documents';

function manifestError(problem: ManifestProblem, fields: string[] = [MANIFEST], extra: Record<string, unknown> = {}): CatalogError {
  return new CatalogError('invalid_manifest', { problem, fields, ...extra });
}

// Top-level front matter keys are plain: `allowed-tools` with a zero-width space, a BOM or a bidi override in it is
// refused, never read as some other key.
const KEY_RE = /^[a-z][a-z0-9_-]*$/;

// The first YAML feature, in document order, that parsers disagree on: a merge key (`<<` is a plain key to a YAML 1.2
// core-schema parser and a merge to PyYAML, so `<<: {allowed-tools: Bash}` would grant a tool the catalog never saw),
// an anchor, an alias or an explicit tag, at any depth.
function unsafeFeature(doc: Document): YamlFeature | undefined {
  let found: YamlFeature | undefined;
  visit(doc, {
    Alias() {
      found ??= 'alias';
      return visit.BREAK;
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.type === 'PLAIN' && pair.key.value === '<<') {
        found ??= 'merge_key';
        return visit.BREAK;
      }
    },
    Node(_key, node) {
      if ((isScalar(node) || isMap(node) || isSeq(node)) && node.anchor) found ??= 'anchor';
      else if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag) found ??= 'tag';
      if (found) return visit.BREAK;
    },
  });
  return found;
}

// Front matter is a safe subset of YAML, so every parser reads the same keys (contract §4.1): one document, YAML's
// core schema, no merge keys, anchors, aliases, explicit tags or duplicate keys, a mapping at the top, plain keys.
export function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FRONT.exec(text);
  if (!m) throw manifestError('no_front_matter');
  const doc = parseDocument(m[1]!, { schema: 'core', uniqueKeys: true, prettyErrors: false });
  const codes = doc.errors.map((e) => e.code);
  if (codes.includes('MULTIPLE_DOCS')) throw manifestError('yaml_feature', undefined, { feature: 'multiple_documents' });
  if (codes.includes('DUPLICATE_KEY')) throw manifestError('yaml_feature', undefined, { feature: 'duplicate_key' });
  const feature = unsafeFeature(doc);
  if (feature) throw manifestError('yaml_feature', undefined, { feature });
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
  const bad = Object.keys(value as Record<string, unknown>).find((k) => !KEY_RE.test(k));
  if (bad !== undefined) throw manifestError('key_format', [bad]);
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
  else if (hasLineBreakOrControl(description)) descriptionProblem = 'control_character';
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
export const TAG_MAX_LENGTH = 32;
const TAG_RE = new RegExp(`^[a-z0-9-]{1,${TAG_MAX_LENGTH}}$`);

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
