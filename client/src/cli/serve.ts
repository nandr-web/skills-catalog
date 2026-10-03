// skills-catalog serve [--port N] [--publish] (contract §3; the web-local build notes, slice 3): a process command beside
// `mcp` (a face, not an operation). In order, before anything is made: a person at a terminal (exit 3 and the person-only
// words otherwise; a backstop, since a command can fake one), then a local catalog (a hosted or malformed one is the
// core's own error, exit 1). Only then the pairing code, the server, and its one printed line. It runs until `stopped`.
import { parseArgs } from 'node:util';
import { CatalogError, renderError, type Words } from '@skills-catalog/core';
import { settingsFrom } from '../settings.ts';
import { serve, type Serving } from '../web/serve.ts';

export type ServeIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  tty: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Resolves when the process should stop (a signal; a test's own promise). */
  stopped: Promise<void>;
  /** Tests only: the code instead of a random one, for the planted-marker test. */
  pairingCode?: string;
};

export async function runServe(argv: readonly string[], s: Words, io: ServeIo, usage: string): Promise<number> {
  let port = 0;
  let publish = false;
  try {
    const { values, positionals } = parseArgs({ args: [...argv], strict: true, allowPositionals: true, options: { port: { type: 'string' }, publish: { type: 'boolean' } } });
    if (positionals.length) throw new Error('positional');
    if (values.port !== undefined) {
      if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) throw new Error('port');
      port = Number(values.port);
    }
    publish = values.publish === true;
  } catch {
    io.stderr(usage);
    return 1;
  }
  if (!io.tty) {
    // Rebuilt from the checked values, never echoed from the argument list.
    const command = [s.cli, 'serve', ...(port ? ['--port', String(port)] : []), ...(publish ? ['--publish'] : [])].join(' ');
    io.stderr(s.format(s.word('errors.person_only_serve'), { command }) + '\n');
    return 3;
  }
  const settings = settingsFrom(io.env, io.cwd);
  if (!settings.catalog.startsWith('file:')) {
    // A local catalog only, whatever else could open it: nothing is opened here, and the refusal is in the core's own
    // words (a hosted catalog, or something that isn't a catalog's address).
    const err = settings.catalog.startsWith('https://')
      ? new CatalogError('forbidden', { catalog: settings.catalog, why: 'hosted_not_available' })
      : new CatalogError('invalid_request', { field: 'catalog', why: 'not_a_catalog_url' });
    io.stderr(renderError(s, err) + '\n');
    return 1;
  }
  let serving: Serving;
  try {
    serving = await serve({ port, publish, settings, words: s, ...(io.pairingCode ? { pairingCode: io.pairingCode } : {}) });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.stderr(s.format(s.word('errors.port_in_use'), { port }) + '\n');
      return 1;
    }
    throw e;
  }
  io.stdout(`${serving.url}\n`);
  io.stdout(`${s.format(s.word('person.serve.started'))}\n`);
  await io.stopped;
  await serving.close();
  return 0;
}
