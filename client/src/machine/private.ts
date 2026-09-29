// §4.5's private-folder test, for the installer and for setup: owned by the person, never world-writable, and
// group-writable only with their own private group (a umask of 002 with per-user groups). Otherwise another user could
// swap what's written there.

type Stats = { uid: bigint; gid: bigint; mode: bigint };

export function isPrivate(s: Stats): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  return s.uid === BigInt(uid) && writableOnlyAsPrivate(s);
}

// Never world-writable, and group-writable only with the user's private group (its gid is the uid); never a shared group
// such as macOS's staff (20).
export function writableOnlyAsPrivate(s: Stats): boolean {
  const uid = BigInt(process.getuid?.() ?? -1);
  if ((s.mode & 0o002n) !== 0n) return false;
  return (s.mode & 0o020n) === 0n || (s.gid === uid && s.gid !== 20n);
}
