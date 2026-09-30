// Imported first by cli.ts, so it runs before anything loads node:sqlite: Node's "SQLite is an experimental feature"
// warning is about Node, not about anything the person can act on, so it isn't shown (the README's MCP line passes
// --disable-warning=ExperimentalWarning for the same reason). Every other warning is shown as usual.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning as Error).name;
  if (type === 'ExperimentalWarning' && /SQLite/.test(text)) return;
  (emit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
