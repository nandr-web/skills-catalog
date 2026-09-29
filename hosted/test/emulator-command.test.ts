// How the stand-in is started: moto from this project's emulator/.venv, or from a full path given in
// SKILLS_CATALOG_MOTO (a reviewer's existing environment, used read-only), with nothing of the person's in its
// environment but PYTHONDONTWRITEBYTECODE when set (so a read-only environment gets no bytecode written into it).

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { motoCommand } from './emulator.ts';

const OWN = fileURLToPath(new URL('../emulator/.venv/bin/moto_server', import.meta.url));
const PLAIN = { PATH: '/usr/bin:/bin', AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' };

describe('starting the stand-in', () => {
  it("moto comes from this project's environment, with a plain environment of its own", () => {
    expect(motoCommand({ HOME: '/Users/someone', AWS_PROFILE: 'work', PATH: '/opt/bin' })).toEqual({ path: OWN, env: PLAIN });
  });

  it('SKILLS_CATALOG_MOTO, a full path, runs that moto instead; PYTHONDONTWRITEBYTECODE is passed through when set', () => {
    expect(motoCommand({ SKILLS_CATALOG_MOTO: '/opt/review/.venv/bin/moto_server', PYTHONDONTWRITEBYTECODE: '1' })).toEqual({
      path: '/opt/review/.venv/bin/moto_server',
      env: { ...PLAIN, PYTHONDONTWRITEBYTECODE: '1' },
    });
  });

  it('a SKILLS_CATALOG_MOTO that is not a full path is refused (it would be looked up on no PATH, or relative to anywhere)', () => {
    for (const p of ['moto_server', './.venv/bin/moto_server', '']) expect(() => motoCommand({ SKILLS_CATALOG_MOTO: p }), p).toThrow('SKILLS_CATALOG_MOTO');
  });
});
