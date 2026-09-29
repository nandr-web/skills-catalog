// A ps whose start times run early, as Linux's can in a VM (it counts a process's start from a boot time kept in whole
// seconds, and the clock may have moved since boot): the real ps, every start it prints moved 90 s back. For the check's
// tests only, started through the node running the tests (test/machine.ts, skewedPs).
const { spawnSync } = require('node:child_process');
const [ps, ...args] = process.argv.slice(2);
const r = spawnSync(ps, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const two = (n) => String(n).padStart(2, '0');
const format = (d) => `${'SunMonTueWedThuFriSat'.substr(d.getDay() * 3, 3)} ${'JanFebMarAprMayJunJulAugSepOctNovDec'.substr(d.getMonth() * 3, 3)} ${String(d.getDate()).padStart(2)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
process.stdout.write((r.stdout ?? '').replace(/\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4}/g, (s) => format(new Date(Date.parse(s) - 90_000))));
process.stderr.write(r.stderr ?? '');
process.exitCode = r.status ?? 1;   // not process.exit(): a pipe would lose what's still being written
