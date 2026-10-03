// Whether the installed product is safe for the session-start hook to run at every session (setup build notes §6): the
// hook runs `<node> <script>` as the person, so whoever can change any of it runs code as them. Read only: node and the
// script by real path; the package's own folder and each dependency's real folder walked (bounded, never following a
// link out of the folder being walked: a link's target is walked as a folder of its own), each dependency its
// package.json names found as Node finds it (the node_modules folders up from the package that names it); every folder
// above them up to `/`. What can't be looked at (a link that can't be followed, a folder that can't be listed, a
// dependency that isn't there) is refused: what setup can't check, it can't call safe.
//
// Who may write: the person, or root. A folder others can write passes only with the sticky bit and only above node's
// own folder (above the package, someone could add a node_modules folder Node would look in). A group may write only
// when it's the person's own private group, wheel (0) or admin (80), whose members can become root anyway; an
// admin-writable folder is named for the summary (Intel Macs' /usr/local). Any other group, staff (20) included, is
// writable_by_others.

import { lstatSync, readdirSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { CatalogError } from '@skills-catalog/core';

export const INSTALL_UNSAFE_WHYS = ['path_characters', 'temporary', 'writable_by_others', 'too_many_files', 'unreadable'] as const;
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
/** `sharedGroup`: the folders the admin group can write, named in the summary. */
export type Install = { node: string; script: string; sharedGroup: string[] };

const unsafe = (path: string, why: InstallUnsafeWhy) => new CatalogError('install_unsafe', { path, why });
// A character a shell line or an MCP config could read as something else.
export const BAD_CHARACTER = /[\u0000-\u001f\u007f$`]/;
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const WHEEL = 0n;
const ADMIN = 80n;
const STAFF = 20n;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw unsafe(path, 'unreadable');
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

/** The dependencies a package's package.json names (its `dependencies`; a dev tool never runs in the hook). */
function dependenciesOf(pkg: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(pkg, 'package.json'), 'utf8');
  } catch {
    return [];
  }
  try {
    const deps = (JSON.parse(text) as { dependencies?: unknown }).dependencies;
    return deps && typeof deps === 'object' ? Object.keys(deps) : [];
  } catch {
    throw unsafe(join(pkg, 'package.json'), 'unreadable');
  }
}

/** Where Node finds `name` from `pkg`: the first node_modules/<name> up from it, or undefined. */
function resolveDependency(pkg: string, name: string): string | undefined {
  for (let at = pkg; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', name);
    try {
      lstatSync(candidate);
      return candidate;
    } catch {
      // not here
    }
    if (dirname(at) === at) return undefined;
  }
}

export function checkInstall({ node: rawNode, script: rawScript, temporaryRoots, uid, limits = WALK_LIMITS }: InstallInput): Install {
  for (const p of [rawNode, rawScript]) if (BAD_CHARACTER.test(p)) throw unsafe(p, 'path_characters');
  const node = real(rawNode);
  const script = real(rawScript);
  for (const p of [node, script]) if (!isAbsolute(p) || BAD_CHARACTER.test(p)) throw unsafe(p, 'path_characters');
  const temporary = temporaryRoots.flatMap((t) => {
    try {
      return [realpathSync(t)];
    } catch {
      return [];
    }
  });
  for (const p of [script, node]) if (p.split(sep).includes('_npx') || temporary.some((t) => under(p, t))) throw unsafe(p, 'temporary');

  const named = new Set<string>();
  const me = BigInt(uid);
  // Others can change it: another user's (root's aside); written by everyone (a folder with the sticky bit aside, only
  // above node); or by a group that isn't the person's private one, wheel or admin.
  const check = (path: string, s: BigIntStats, stickyPasses: boolean) => {
    if (s.isSymbolicLink()) return;
    if (s.uid !== me && s.uid !== 0n) throw unsafe(path, 'writable_by_others');
    if ((s.mode & 0o002n) !== 0n) {
      if (stickyPasses && s.isDirectory() && (s.mode & 0o1000n) !== 0n) return;
      throw unsafe(path, 'writable_by_others');
    }
    if ((s.mode & 0o020n) !== 0n) {
      const privateGroup = s.gid === me && s.gid !== STAFF;
      if (s.gid === ADMIN) named.add(path);
      else if (!privateGroup && s.gid !== WHEEL) throw unsafe(path, 'writable_by_others');
    }
  };
  const look = (path: string) => {
    try {
      return lstatSync(path, { bigint: true });
    } catch {
      throw unsafe(path, 'unreadable');
    }
  };
  // Each folder above `path`, up to `/`; the sticky bit passes from `stickyFrom` folders up (never for the first ones).
  const above = (path: string, stickyFrom: number) => {
    for (let at = dirname(path), n = 0; ; at = dirname(at), n++) {
      check(at, look(at), n >= stickyFrom);
      if (dirname(at) === at) return;
    }
  };

  check(node, look(node), false);
  above(node, 1); // node's own folder never passes on the sticky bit; the folders above it may
  // The package's folder and each dependency's real folder, each walked once; the count is across them all.
  const roots = [packageOf(script)];
  const walked = new Set<string>();
  let entries = 0;
  while (roots.length) {
    const root = roots.shift()!;
    if ([...walked].some((w) => under(root, w))) continue;
    walked.add(root);
    above(root, Infinity);
    for (const dep of dependenciesOf(root)) {
      const found = resolveDependency(root, dep);
      if (found === undefined) throw unsafe(join(root, 'node_modules', dep), 'unreadable');
      const target = real(found);
      if (![...walked, root].some((w) => under(target, w))) roots.push(target);
    }
    const stack: [string, number][] = [[root, 0]];
    while (stack.length) {
      const [path, depth] = stack.pop()!;
      if (++entries > limits.entries || depth > limits.depth) throw unsafe(root, 'too_many_files');
      const s = look(path);
      check(path, s, false);
      if (s.isSymbolicLink()) {
        const target = real(path);
        if (!under(target, root)) roots.push(target);
      } else if (s.isDirectory()) {
        let names: string[];
        try {
          names = readdirSync(path);
        } catch {
          throw unsafe(path, 'unreadable');
        }
        for (const name of names) stack.push([join(path, name), depth + 1]);
      }
    }
  }
  return { node, script, sharedGroup: [...named] };
}
