// Each preset's whole template, pinned: a change to the stack shows here as a diff to read before it's accepted. The
// functions' asset names (hashes of their bundles) are left out, since any code change moves them. Nothing secret is in
// either template: secrets are parameter names and references, resolved by CloudFormation or read at run time.

import { describe, expect, it } from 'vitest';
import { synth } from './synth.ts';

const ASSET = /[0-9a-f]{64}(\.zip)?/g;

for (const preset of ['throwaway', 'demo'] as const) {
  describe(`the ${preset} template`, () => {
    const json = JSON.stringify(synth(preset).toJSON(), null, 2);

    it('is as pinned (asset hashes aside)', () => {
      expect(json.replace(ASSET, '<asset>')).toMatchSnapshot();
    });

    it('holds no secret: no key, token or private key, and the origin secret only as a parameter reference or name', () => {
      for (const secret of [/AKIA[0-9A-Z]{16}/, /gh[opsu]_[A-Za-z0-9]{20,}/, /-----BEGIN/, /aws_secret_access_key/i]) expect(json).not.toMatch(secret);
      const uses = json.match(/[^"]*origin-secret[^"]*/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      // A reference CloudFormation resolves, the name the function is told, or the name in the role's parameter ARN.
      for (const u of uses) expect(u, u).toMatch(/^(\{\{resolve:ssm:\/skills-catalog\/[a-z]+\/origin-secret:\d+\}\}|\/skills-catalog\/[a-z]+\/origin-secret(-previous)?|:ssm:[a-z0-9-]+:\d{12}:parameter\/skills-catalog\/[a-z]+\/origin-secret(-previous)?)$/);
    });
  });
}
