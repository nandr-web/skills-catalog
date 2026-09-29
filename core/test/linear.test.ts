// The linear-time check itself: linear work passes, quadratic work fails, and the two sizes are timed in turns, so a
// stretch of load from other suites on the same machine slows both alike instead of only the one timed while it lasts.
import { describe, expect, it } from 'vitest';
import { expectLinear } from './linear.ts';

// Busy work of `units` steps, about 0.02 ms each. Each case times its runs many times over, and on a busy machine that
// can take longer than a test's default few seconds: each has its own minute, as the other linear-time tests do.
function spin(units: number): number {
  let x = 0;
  for (let i = 0; i < units * 20_000; i++) x = (x + i) % 1_000_003;
  return x;
}

describe('expectLinear', () => {
  it('passes work that grows in step with its input', () => {
    expectLinear('linear', (scale) => Math.round(400 * scale), (n) => spin(n));
  }, 60_000);

  it('fails work that grows with the square of its input', () => {
    expect(() => expectLinear('quadratic', (scale) => Math.round(100 * scale), (n) => spin((n * n) / 4))).toThrow(/for a quarter of it/);
  }, 60_000);

  it('times the two sizes in turns, after the first full-size run', () => {
    const sizes: string[] = [];
    expectLinear('in turns', (scale) => (scale === 1 ? 'full' : 'quarter'), (s) => (sizes.push(s), spin(s === 'full' ? 40 : 10)));
    expect(sizes.slice(0, 11)).toEqual(['full', ...Array.from({ length: 5 }, () => ['quarter', 'full']).flat()]);
  }, 60_000);
});
