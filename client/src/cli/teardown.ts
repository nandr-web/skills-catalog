// `skills-catalog teardown` (setup build notes §5; skill-setup-welcome's "teardown undoes everything setup wrote"): runs
// machine/teardown-run.ts and says, per thing setup added, whether it was removed, left because it changed (with how to
// remove it by hand), or already gone; what it keeps and where. Colour only at a terminal and never alone. Exit 0 done,
// 1 when setup's record couldn't be used (nothing was removed) or a refusal.

import { CatalogError, renderError, Words } from '@skills-catalog/core';
import { flagText } from '@skills-catalog/core/skill-tree';
import { runTeardown, type TeardownLine, type What } from '../machine/teardown-run.ts';
import { painter } from '../person/terminal.ts';
import { settingsFrom } from '../settings.ts';
import { fileURLToPath } from 'node:url';
import { cliWords } from './words.ts';

export type TeardownIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  color: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  uid?: number;
  now?: () => number;
};

export async function runTeardownCommand(argv: readonly string[], io: TeardownIo): Promise<number> {
  const s = cliWords(Words.load());
  const w = s.setup.teardown;
  const paint = painter(io.color);
  if (argv.length) {
    io.stderr(`${s.cli} teardown\n`);
    return 1;
  }
  const settings = settingsFrom(io.env, io.cwd);
  let r: Awaited<ReturnType<typeof runTeardown>>;
  try {
    r = await runTeardown({ assistantHome: settings.assistantHome, skillsHome: settings.home, env: io.env, uid: io.uid ?? process.getuid?.() ?? -1, now: io.now ?? (() => Date.now()) });
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    io.stderr(renderError(s, e) + '\n');
    return 1;
  }
  // Paths and rules come from setup's record, read leniently: shown with any control character escaped.
  const what = (x: What) => s.format(w.what[x.kind], x.rule === undefined ? {} : { rule: flagText(x.rule) });
  const line = (raw: TeardownLine): string => {
    const l = { ...raw, path: flagText(raw.path) } as TeardownLine;
    switch (l.state) {
      case 'removed':
        return paint('ok', `✓ ${s.format(w.removed, { path: l.path, what: what(l.what) }).replace(/^- /, '')}`);
      case 'changed':
        return paint('attention', `▲ ${s.format(w.changed, { path: l.path, what: what(l.what) }).replace(/^- /, '')}`);
      case 'gone':
        return s.format(w.gone, { path: l.path, what: what(l.what) });
      case 'unusable':
        return paint('attention', `▲ ${s.format(w.unusable, { path: l.path, why: s.setup.file_why[l.why] ?? l.why }).replace(/^- /, '')}`);
      case 'not_here':
        return s.format(w.not_here, { path: l.path });
      case 'damaged':
        return s.format(w.damaged, { path: l.path });
    }
  };
  if (r.recordUnusable) {
    if (!r.recordUnusable.found.length) {
      io.stdout([w.nothing, ...r.lines.map(line)].join('\n') + '\n');
      return 0;
    }
    io.stdout([paint('attention', `▲ ${s.format(w.record_unusable, { path: r.places.record })}`), ...r.recordUnusable.found.map((f) => s.format(w.record_unusable_line, { path: flagText(f.path), what: what(f.what) })), ...r.lines.map(line)].join('\n') + '\n');
    return 1;
  }
  const acted = r.lines.filter((l) => l.state !== 'damaged');
  const catalog = settings.catalog.startsWith('file:') ? fileURLToPath(settings.catalog) : settings.catalog;
  const out = acted.length ? [paint('bold', w.header), ...r.lines.map(line)] : [w.nothing, ...r.lines.map(line)];
  for (const b of r.backups) out.push(s.format(s.setup.restore, { file: b.endsWith('-claude.json') ? r.places.claudeJson : r.places.settingsJson, backup: b }));
  out.push(s.format(w.kept, { catalog, home: settings.home, backups: r.places.backups }), w.next);
  io.stdout(out.join('\n') + '\n');
  return 0;
}
