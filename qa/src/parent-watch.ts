// The parent watch: a qa command a test started (--fake-machine) stops itself when that test is gone, so a test that
// timed out, crashed or was killed never leaves qa, and what qa started, running with nobody to stop it. The tests'
// helpers say which process started the command (QA_TEST_PID), and that process is watched; without it, the parent is:
// gone when its id changes (the process was taken over by init or a subreaper), or already init's at the start (the
// starter exited before the command got going). Nothing is watched when a person runs qa.

/** Calls `onGone` once, the first time the watched process is gone. Returns a stop; the timer never keeps the process
 *  alive on its own. */
export function watchParent(onGone: () => void, o: { pid?: number; ppid?: () => number; alive?: (pid: number) => boolean; everyMs?: number } = {}): () => void {
  const ppid = o.ppid ?? (() => process.ppid);
  const alive = o.alive ?? isAlive;
  const first = ppid();
  const gone = o.pid !== undefined ? () => !alive(o.pid!) : () => ppid() !== first || first === 1;
  const timer = setInterval(() => {
    if (!gone()) return;
    clearInterval(timer);
    onGone();
  }, o.everyMs ?? 500);
  timer.unref();
  return () => clearInterval(timer);
}

/** The process the tests' helpers say started this command, when they said a valid one. */
export function testPid(env: Record<string, string | undefined> = process.env): number | undefined {
  const pid = Number(env['QA_TEST_PID']);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';   // there, but someone else's: still alive
  }
}
