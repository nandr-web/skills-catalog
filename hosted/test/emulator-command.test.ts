// How the stand-in is started: moto from this project's emulator/.venv, or from a full path given in CATALOG_TEST_MOTO
// (a reviewer's existing environment, used read-only), with nothing of the person's in its environment but
// PYTHONDONTWRITEBYTECODE when set (so a read-only environment gets no bytecode written into it). The variable's name
// must survive the core's fail-safe, which clears every SKILLS_* variable before a test file loads.

import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from '@skills-catalog/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MOTO_VARIABLE, motoCommand, startEmulator } from './emulator.ts';

const OWN = fileURLToPath(new URL('../emulator/.venv/bin/moto_server', import.meta.url));
const PLAIN = { PATH: '/usr/bin:/bin', AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' };

describe('starting the stand-in', () => {
  it("moto comes from this project's environment, with a plain environment of its own", () => {
    expect(motoCommand({ HOME: '/home/someone', AWS_PROFILE: 'work', PATH: '/opt/bin' })).toEqual({ path: OWN, env: PLAIN });
  });

  it(`${MOTO_VARIABLE}, a full path, runs that moto instead; PYTHONDONTWRITEBYTECODE is passed through when set`, () => {
    expect(motoCommand({ [MOTO_VARIABLE]: '/opt/review/.venv/bin/moto_server', PYTHONDONTWRITEBYTECODE: '1' })).toEqual({
      path: '/opt/review/.venv/bin/moto_server',
      env: { ...PLAIN, PYTHONDONTWRITEBYTECODE: '1' },
    });
  });

  it(`a ${MOTO_VARIABLE} that is not a full path is refused (it would be looked up on no PATH, or relative to anywhere)`, () => {
    for (const p of ['moto_server', './.venv/bin/moto_server', '']) expect(() => motoCommand({ [MOTO_VARIABLE]: p }), p).toThrow(MOTO_VARIABLE);
  });

  it("its name isn't one the core's fail-safe clears", () => {
    expect(MOTO_VARIABLE.startsWith('SKILLS_')).toBe(false);
  });

  describe('under the fail-safe, as a run is', () => {
    const before = process.env[MOTO_VARIABLE];
    afterEach(() => {
      if (before === undefined) delete process.env[MOTO_VARIABLE];
      else process.env[MOTO_VARIABLE] = before;
    });

    it('the stand-in is started from the path in the variable', async () => {
      const dir = sandbox();
      const marker = join(dir, 'was-started');
      const fake = join(dir, 'moto_server');
      // A moto that only leaves its mark and stops, so the stand-in never comes up.
      writeFileSync(fake, `#!/bin/sh\n: > '${marker}'\nexit 1\n`);
      chmodSync(fake, 0o755);
      process.env[MOTO_VARIABLE] = fake;
      // A stand-in that does come up (from another moto) is stopped at once: this test never leaves one running.
      const outcome = await startEmulator().then(
        async (emu) => (await emu.stop(), 'started another moto'),
        (e: Error) => e.message,
      );
      expect(outcome).toContain("didn't start");
      expect(existsSync(marker)).toBe(true);
    }, 30_000);
  });
});
