// The contract's error codes (§9). An error carries its code and the fields its sentence needs; the sentence itself
// comes from the agent-experience wording (surface.ts), so the CLI and MCP faces say the same thing.

export type ErrorCode =
  | 'internal_error'
  | 'invalid_request'
  | 'invalid_developer_setting'
  | 'invalid_manifest'
  | 'invalid_name'
  | 'invalid_path'
  | 'too_large'
  | 'not_found'
  | 'not_owner'
  | 'conflict'
  | 'forbidden'
  | 'unauthenticated'
  | 'exists_untracked'
  | 'name_in_use'
  | 'target_symlink'
  | 'secret_suspected'
  | 'fingerprint_mismatch'
  | 'not_installed'
  | 'invalid_local_file'
  | 'target_changed'
  | 'target_not_private';

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
