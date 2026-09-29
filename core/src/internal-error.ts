// An error that isn't one of the contract's codes is a bug in skills-catalog. The CLI and MCP faces show no traceback
// (assistants that saw one tried to patch the tool's own files): the traceback goes to a log in $SKILLS_HOME/logs,
// and the result is internal_error {log} (contract §9).

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, isCatalogError } from './errors.ts';

// `suffix` tells apart the logs of errors in the same millisecond (tests fix it to plant a file at the log's path).
export function toCatalogError(e: unknown, home: string, now: Date = new Date(), suffix: string = randomBytes(4).toString('hex')): CatalogError {
  if (isCatalogError(e)) return e;
  const logs = join(home, 'logs');
  const log = join(logs, `internal-error-${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}-${suffix}.log`);
  try {
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    writeFileSync(log, `${now.toISOString()}\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`, { mode: 0o600, flag: 'wx' }); // a new file only, never through an existing file or link
  } catch {
    return new CatalogError('internal_error', {}); // no log: its sentence says the log couldn't be written either
  }
  return new CatalogError('internal_error', { log });
}
