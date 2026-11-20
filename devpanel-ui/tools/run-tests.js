'use strict';

/*
 * Runs every test of the panel, one process each, and sums them up.
 *
 *   npm test
 *
 * Plain Node on purpose: no test framework to install, so the same command works on a
 * contributor's machine and in CI. A test that does not apply to this system (the Linux
 * platform layer on Windows) says so with exit code 2 and is counted as skipped.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS = [
  'test-settings.js',
  'test-core.js',
  'test-modules.js',
  'test-i18n.js',
  'test-telepresence.js',
  'test-installer.js',
  'test-setup.js',
  'test-network.js',
  'test-server-guard.js',
  'test-relink-guard.js',
  'test-linux-platform.js',
];

let failed = 0;
const summary = [];

for (const name of TESTS) {
  console.log('\n================ ' + name + ' ================');
  const r = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: 'inherit' });
  const verdict = r.status === 0 ? 'passed' : r.status === 2 ? 'skipped (not this system)' : 'FAILED';
  if (verdict === 'FAILED') failed += 1;
  summary.push('  ' + verdict.padEnd(26) + name);
}

console.log('\n================ summary ================');
console.log(summary.join('\n'));
process.exit(failed ? 1 : 0);
