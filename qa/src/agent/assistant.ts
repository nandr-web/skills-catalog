// Which assistant binary a live run starts. Only by a full path: a bare `claude` runs whatever copy PATH finds first, and a
// copy macOS never approved shows the person its "downloaded from the Internet" prompt, even for --version. The default
// is Claude Code's own install place in the machine's home (~/.local/bin/claude; a fake machine has none, so a test can
// never reach the real one); a path given is resolved with realpath and must be a real executable file; on macOS, a file
// whose quarantine mark was never approved (no 0x40 in its com.apple.quarantine flags) is refused before anything runs it.
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Machine } from '../machine.ts';
import { UnsafeError } from '../safe-delete.ts';

/** Claude Code's own install place in the machine's home. */
export const defaultAssistant = (m: Machine): string[] => [join(m.home, '.local', 'bin', 'claude')];

/** macOS's quarantine flags on a file (a hex number, the attribute's first field), or undefined when it has none. An
 *  unreadable value comes back as NaN, which counts as never approved. */
function quarantineFlags(path: string): number | undefined {
  if (platform() !== 'darwin') return undefined;
  const r = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path], { encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  return parseInt(r.stdout.split(';')[0] ?? '', 16);
}

/** The assistant command with its binary resolved to its real path, after the checks; runs nothing. Throws UnsafeError,
 *  naming why, for a bare name or a relative path, a missing file, a folder, a file that can't run, or a copy macOS
 *  never approved. */
export function resolveAssistant(command: string[]): string[] {
  const [bin, ...rest] = command;
  if (!bin || !isAbsolute(bin)) {
    throw new UnsafeError(`the assistant must be given by its full path (${JSON.stringify(bin ?? '')} isn't one): a bare name runs whatever copy PATH finds first; nothing started`);
  }
  let real: string;
  try {
    real = realpathSync.native(bin);
  } catch {
    throw new UnsafeError(`the assistant ${bin} doesn't exist; nothing started`);
  }
  const st = statSync(real);
  if (!st.isFile() || (st.mode & 0o111) === 0) throw new UnsafeError(`the assistant ${real} isn't an executable file; nothing started`);
  const flags = quarantineFlags(real);
  if (flags !== undefined && !(flags & 0x40)) {
    throw new UnsafeError(`the assistant ${real} carries macOS's quarantine mark and was never approved: running it, even for --version, would show the person a "downloaded from the Internet" prompt; nothing started`);
  }
  return [real, ...rest];
}

/** The assistant's --version, first line (the binary already resolved and checked). */
export function assistantVersion(command: string[], env: Record<string, string>): string {
  const r = spawnSync(command[0]!, [...command.slice(1), '--version'], { encoding: 'utf8', env, timeout: 30_000 });
  return (r.stdout ?? '').trim().split('\n')[0] || `no version (exit ${r.status})`;
}
