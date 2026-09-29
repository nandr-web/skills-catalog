// Whether the installed product is safe for the session-start hook to run at every session (setup build notes §6): the
// hook runs `<node> <script>` as the person, so whoever can change any of it runs code as them. Read only: node and the
// script by real path; the package's own folder and each dependency's real folder walked (bounded, never following a
// link out of the folder being walked: a link's target is walked as a folder of its own); every folder above them up to
// the first one root owns. A shared group's folder passes and is named for the summary.

import { lstatSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { CatalogError } from '@skills-catalog/core';

export const INSTALL_UNSAFE_WHYS = ['path_characters', 'temporary', 'writable_by_others', 'too_many_files'] as const;
export type InstallUnsafeWhy = (typeof INSTALL_UNSAFE_WHYS)[number];

export const WALK_LIMITS = { entries: 20_000, depth: 40 };

export type InstallInput = {
  /** process.execPath. */
  node: string;
  /** The file the package's bin names. */
  script: string;
  /** Folders that get cleaned: the system's temp folders. */
  temporaryRoots: readonly string[];
  /** The effective user. */
  uid: number;
  limits?: { entries: number; depth: number };
};
export type Install = { node: string; script: string; sharedGroup: string[] };

const unsafe = (path: string, why: InstallUnsafeWhy) => new CatalogError('install_unsafe', { path, why });
// A character a shell line or an MCP config could read as something else.
export const BAD_CHARACTER = /[\u0000-\u001f\u007f$`]/;
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The folder with the package.json nearest above the script: the package's own folder. */
function packageOf(script: string): string {
  for (let at = dirname(script); dirname(at) !== at; at = dirname(at)) {
    try {
      if (lstatSync(join(at, 'package.json')).isFile()) return at;
    } catch {
      // not here
    }
  }
  return dirname(script);
}

export function checkInstall({ node: rawNode, script: rawScript, temporaryRoots, uid, limits = WALK_LIMITS }: InstallInput): Install {
  const node = real(rawNode);
  const script = real(rawScript);
  for (const p of [node, script]) if (!isAbsolute(p) || BAD_CHARACTER.test(p)) throw unsafe(p, 'path_characters');
  if (script.split(sep).includes('_npx') || temporaryRoots.some((t) => under(script, real(t)))) throw unsafe(script, 'temporary');

  const shared = new Set<string>();
  // Others can change it: another user's (root's aside), or world-writable (a folder with the sticky bit aside). A
  // group-writable one whose group isn't the person's own is noted.
  const check = (path: string, s: BigIntStats) => {
    if (s.isSymbolicLink()) return;
    if (s.uid !== BigInt(uid) && s.uid !== 0n) throw unsafe(path, 'writable_by_others');
    if ((s.mode & 0o002n) !== 0n && !(s.isDirectory() && (s.mode & 0o1000n) !== 0n)) throw unsafe(path, 'writable_by_others');
    if ((s.mode & 0o020n) !== 0n && s.gid !== BigInt(uid)) shared.add(path);
  };
  const look = (path: string) => lstatSync(path, { bigint: true });
  // Each folder above `path`, up to and including the first one root owns.
  const above = (path: string) => {
    for (let at = dirname(path); ; at = dirname(at)) {
      const s = look(at);
      check(at, s);
      if (s.uid === 0n || dirname(at) === at) return;
    }
  };

  check(node, look(node));
  above(node);
  // The package's folder and each dependency's real folder, each walked once; the count is across them all.
  const roots = [packageOf(script)];
  const walked = new Set<string>();
  let entries = 0;
  while (roots.length) {
    const root = roots.shift()!;
    if ([...walked].some((w) => under(root, w))) continue;
    walked.add(root);
    above(root);
    const stack: [string, number][] = [[root, 0]];
    while (stack.length) {
      const [path, depth] = stack.pop()!;
      if (++entries > limits.entries || depth > limits.depth) throw unsafe(root, 'too_many_files');
      const s = look(path);
      check(path, s);
      if (s.isSymbolicLink()) {
        const target = real(path);
        if (!under(target, root)) roots.push(target);
      } else if (s.isDirectory()) {
        let names: string[];
        try {
          names = readdirSync(path);
        } catch {
          continue; // a folder node can't list, it can't load from either
        }
        for (const name of names) stack.push([join(path, name), depth + 1]);
      }
    }
  }
  return { node, script, sharedGroup: [...shared] };
}
