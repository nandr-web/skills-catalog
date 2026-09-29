// Preloaded into the qa command line (NODE_OPTIONS=--import) by a test: this machine has no lsof, as a Linux machine
// without it installed. Only the answer to "is lsof there?" changes; nothing else is touched.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const existsSync = fs.existsSync;
fs.existsSync = (p) => (/\/lsof$/.test(String(p)) ? false : existsSync(p));
syncBuiltinESMExports();
