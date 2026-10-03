// The contract's error codes (§9). An error carries its code and the fields its sentence needs; the sentence itself
// comes from the agent-experience wording (words-file.ts), so the CLI and MCP faces say the same thing.

// The list is data at run time (the web page and the published schema read it), in §9's order; a test compares it with
// §9. Setup's own codes (assistant_file_unusable and the four after it) are listed there for setup (§6).
export const ERROR_CODES = [
  'internal_error',
  'invalid_request',
  'invalid_manifest',
  'invalid_name',
  'invalid_path',
  'too_large',
  'not_found',
  'not_owner',
  'conflict',
  'forbidden',
  'unauthenticated',
  'exists_untracked',
  'name_in_use',
  'target_symlink',
  'secret_suspected',
  'invalid_developer_setting',
  'fingerprint_mismatch',
  'lock_busy',
  'not_installed',
  'invalid_local_file',
  'target_changed',
  'target_not_private',
  'target_unavailable',
  'catalog_unreachable',
  'assistant_file_unusable',
  'assistant_file_changed',
  'name_taken',
  'install_unsafe',
  'assistant_config_elsewhere',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// What any call can return, besides its own (the API page's "errors any call can return"): a field outside its schema,
// the demo-developer setting that isn't a name, a bug, and a hosted catalog address where only a local one is built.
export const COMMON_ERRORS = ['invalid_request', 'invalid_developer_setting', 'internal_error', 'forbidden'] as const satisfies readonly ErrorCode[];

export class CatalogError extends Error {
  readonly code: ErrorCode;
  readonly data: Record<string, unknown>;

  constructor(code: ErrorCode, data: Record<string, unknown> = {}) {
    super(`${code}: ${JSON.stringify(data)}`);
    this.name = 'CatalogError';
    this.code = code;
    this.data = data;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, ...this.data };
  }
}

export function isCatalogError(e: unknown, code?: ErrorCode): e is CatalogError {
  return e instanceof CatalogError && (code === undefined || e.code === code);
}
