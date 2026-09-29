// The race tests' view of node:fs: every lstatSync, renameSync and writeSync call runs the test's hooks first, and a stat can be
// rewritten (an owner or mode another user's folder would have). A test file mocks node:fs with mockFs:
//   vi.mock('node:fs', async (original) => (await import('./race-fs.ts')).mockFs(await original()));
// No value import of node:fs here: this module is loaded while that mock is being made.
type Fs = typeof import('node:fs');
type Stats = import('node:fs').Stats;

// The real node:fs (for the tests' own swaps), and the hooks.
export const race = {
  fs: undefined as unknown as Fs,
  onLstat: undefined as undefined | ((path: string) => void),
  onRename: undefined as undefined | ((from: string, to: string) => void),
  afterRename: undefined as undefined | ((from: string, to: string) => void),
  // Rewrites what an lstat reports (an owner or mode another user's folder would have).
  stats: undefined as undefined | ((path: string, s: Stats) => Partial<Stats> | undefined),
  // Runs before every writeSync to a descriptor; throwing makes the write fail (a full disk).
  onWrite: undefined as undefined | ((fd: number) => void),
};

export function mockFs(fs: Fs): Fs {
  race.fs = fs;
  // What a stat reports, after the test's rewrite; the installer reads bigint stats, so numbers become bigints to match.
  const rewrite = (path: string, s: Stats | undefined) => {
    const change = s && race.stats?.(path, s);
    const fit = change && typeof (s as { mode: unknown }).mode === 'bigint' ? Object.fromEntries(Object.entries(change).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v])) : change;
    return fit ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, fit) : s;
  };
  const lstatSync = ((path: string, ...rest: unknown[]) => {
    race.onLstat?.(String(path));
    return rewrite(String(path), (fs.lstatSync as (...a: unknown[]) => unknown)(path, ...rest) as Stats | undefined);
  }) as Fs['lstatSync'];
  const statSync = ((path: string, ...rest: unknown[]) => rewrite(String(path), (fs.statSync as (...a: unknown[]) => unknown)(path, ...rest) as Stats | undefined)) as Fs['statSync'];
  const renameSync = (from: string, to: string) => {
    race.onRename?.(String(from), String(to));
    fs.renameSync(from, to);
    race.afterRename?.(String(from), String(to));
  };
  const writeSync = ((fd: number, ...rest: unknown[]) => {
    race.onWrite?.(fd);
    return (fs.writeSync as (...a: unknown[]) => number)(fd, ...rest);
  }) as Fs['writeSync'];
  return { ...fs, lstatSync, statSync, renameSync, writeSync, default: { ...fs, lstatSync, statSync, renameSync, writeSync } } as Fs;
}
