// A timing check that holds on a busy machine: instead of a wall-clock ceiling, it proves the work grows in step with
// its input. The full input must take under 8 times as long as a quarter of it (linear work takes 4 times, quadratic
// 16), each size timed best of 5, plus a floor for timer noise on tiny inputs. What's timed is the CPU time this process
// spends (each test file runs in its own process), not the wall clock: other processes on a loaded machine take the CPU
// away mid-run, and a long run loses it more often than a short one, which once made linear work read as 13.5 times at
// load 25. The two sizes are timed in turns (a quarter, then all of it, five times), and a miss is measured once more,
// so garbage collection or a cold cache in one stretch can't fail it alone. One generous ceiling stays as a hang guard,
// on the wall clock: the full input's first run must finish within 10 s. It is checked when that run returns, so a run
// that never returns is stopped by the test's own timeout instead.

import { expect } from 'vitest';

const HANG_MS = 10_000;
const NOISE_MS = 20;

// Milliseconds of CPU time (user and system) this process spends on `run`; also a CPU ceiling's measure.
export function cpuMs(run: () => unknown): number {
  const t = process.cpuUsage();
  run();
  const d = process.cpuUsage(t);
  return (d.user + d.system) / 1000;
}

// The best time of each size over five turns of a quarter then the whole.
function inTurns(quarter: () => unknown, whole: () => unknown): { a: number; b: number } {
  let a = Infinity;
  let b = Infinity;
  for (let i = 0; i < 5; i++) {
    a = Math.min(a, cpuMs(quarter));
    b = Math.min(b, cpuMs(whole));
  }
  return { a, b };
}

// `input(scale)` builds the input at that fraction of its full size (1 is full, 0.25 a quarter).
export function expectLinear<T>(label: string, input: (scale: number) => T, run: (x: T) => unknown): void {
  const full = input(1);
  const quarter = input(0.25);
  const t = performance.now();
  run(full);
  expect(performance.now() - t, `${label}: over ${HANG_MS / 1000} s`).toBeLessThan(HANG_MS);
  let { a, b } = inTurns(() => run(quarter), () => run(full));
  if (b >= 8 * a + NOISE_MS) ({ a, b } = inTurns(() => run(quarter), () => run(full)));
  expect(b, `${label}: ${a.toFixed(1)} ms of CPU for a quarter of it, ${b.toFixed(1)} ms for all of it (best of five, measured twice)`).toBeLessThan(8 * a + NOISE_MS);
}

// n copies of s, at a scale (rounded, at least one).
export const times = (s: string, n: number) => (scale: number) => s.repeat(Math.max(1, Math.round(n * scale)));
