// The installer decides from bytes it checked (contract §5.3): a fetched version's bytes against the fingerprint the
// catalog claims for them, then today's full validation with this copy of the rules (paths, the name with its reserved
// list, the manifest), so a version stored before a rule existed never installs past it. The catalog's own verdict is
// never read.

import { CatalogError } from './errors.ts';
import { checkManifest, checkName } from './manifest.ts';
import { checkTree, fingerprint, sha256Hex, type Mode, type TreeFile } from './tree.ts';

// A claimed fingerprint is shown only in the fingerprint's own form: the catalog chose the string.
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export function checkFetched(name: string, version: number, claimed: unknown, files: readonly { path: string; mode: string; bytes: Uint8Array }[]): TreeFile[] {
  const got = fingerprint(files.map((f) => ({ path: f.path, mode: f.mode as Mode, sha256: sha256Hex(f.bytes) })));
  if (got !== claimed) {
    throw new CatalogError('fingerprint_mismatch', { name, version, expected: typeof claimed === 'string' && FINGERPRINT.test(claimed) ? claimed : null, got });
  }
  const tree = checkTree(files);
  checkName(name);
  checkManifest(tree, name);
  return tree;
}
