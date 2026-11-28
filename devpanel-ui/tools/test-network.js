'use strict';

/*
 * The network path: the ports k3d must publish on the host, and what the hosts file must say. Pure: no Docker, no cluster, no file is touched.
 *
 *   node tools/test-network.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Network, PUBLISHED_PORTS, planHosts, isHostName } = require('../src/main/network');

let passed = 0;
let failed = 0;

function test(title, fn) {
  try {
    fn();
    passed += 1;
    console.log('  OK    ' + title);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + title);
    console.log('        ' + (err && err.message));
  }
}

console.log('\n--- published ports ---');

test('the stack needs HTTP, HTTPS, the telepresence entry point and horizon\'s WebTransport (UDP)', () => {
  assert.deepStrictEqual(PUBLISHED_PORTS, ['80/tcp', '443/tcp', '8443/tcp', '30101/udp']);
});

test('start-dev publishes exactly those ports', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts_linux', 'start-dev.sh'), 'utf8');
  for (const p of PUBLISHED_PORTS) {
    const [port, proto] = p.split('/');
    const flag = proto === 'udp' ? port + ':' + port + '/udp@loadbalancer' : port + ':' + port + '@loadbalancer';
    assert.ok(sh.includes(flag), 'start-dev.sh does not publish ' + p);
  }
});

test('the load balancer container is named after the cluster', () => {
  assert.strictEqual(new Network({ config: { k3d: { cluster: 'dyingstar' } } }).lbContainer(), 'k3d-dyingstar-serverlb');
  assert.strictEqual(new Network({ config: { k3d: { cluster: 'dev2' } } }).lbContainer(), 'k3d-dev2-serverlb');
  assert.strictEqual(new Network({ config: {} }).lbContainer(), 'k3d-dyingstar-serverlb');
});

console.log('\n--- the hosts file ---');

const NAMES = ['horizon.dyingstar.local', 'auth.dyingstar.local'];

test('names already pointing at the address: nothing to write', () => {
  const text = '# comment\r\n127.0.0.1 localhost\r\n127.0.0.1 horizon.dyingstar.local\r\n127.0.0.1 auth.dyingstar.local\r\n';
  assert.deepStrictEqual(planHosts(text, NAMES, '127.0.0.1').missing, []);
});

test('a missing name is added; the rest of the file and its line endings are kept', () => {
  const text = '# keep me\r\n127.0.0.1 localhost\r\n127.0.0.1 horizon.dyingstar.local\r\n';
  const plan = planHosts(text, NAMES, '127.0.0.1');
  assert.deepStrictEqual(plan.missing, ['auth.dyingstar.local']);
  assert.strictEqual(plan.text,
    '# keep me\r\n127.0.0.1 localhost\r\n127.0.0.1 horizon.dyingstar.local\r\n127.0.0.1 auth.dyingstar.local\r\n');
});

test('a name pointing elsewhere (the tunnel\'s address) is replaced, not duplicated', () => {
  const text = '10.96.12.7 horizon.dyingstar.local\n10.96.12.7 auth.dyingstar.local\n192.168.1.5 nas\n';
  const plan = planHosts(text, NAMES, '127.0.0.1');
  assert.deepStrictEqual(plan.missing, NAMES);
  assert.strictEqual(plan.text, '192.168.1.5 nas\n127.0.0.1 horizon.dyingstar.local\n127.0.0.1 auth.dyingstar.local\n');
});

test('a commented-out line does not count, and writing is idempotent', () => {
  const plan = planHosts('# 127.0.0.1 horizon.dyingstar.local\n', NAMES, '127.0.0.1');
  assert.deepStrictEqual(plan.missing, NAMES);
  assert.deepStrictEqual(planHosts(plan.text, NAMES, '127.0.0.1'), { missing: [], text: plan.text });
});

test('only plain host names reach the elevated script', () => {
  for (const ok of ['horizon.dyingstar.local', 'a', 'x-1.example']) assert.strictEqual(isHostName(ok), true, ok);
  for (const bad of ['', 'a b', 'x;rm -rf /', '$(id)', 'a\'b', '-leading', 'trailing-', 'a/b']) {
    assert.strictEqual(isHostName(bad), false, bad);
  }
});

test('the elevated Windows script refuses anything but names and an address', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-hosts.ps1'), 'utf8');
  assert.ok(/not a host name/.test(script) && /not an address/.test(script));
  assert.ok(!/Invoke-Expression|iex /i.test(script), 'the script must not evaluate anything it is given');
});

test('the hosts file can also be written by hand: one pasteable sudo line, none on Windows', () => {
  const { hostsCommand } = require('../src/main/network');
  const line = hostsCommand(['auth.dyingstar.local'], '127.0.0.1', 'linux');
  assert.ok(line.startsWith('sudo sh -c "'), line);
  assert.ok(line.includes('127.0.0.1 auth.dyingstar.local'), 'the name and the address');
  assert.ok(line.includes('auth\\\\.dyingstar\\\\.local'), 'dots escaped for sed, and for the double quotes');
  assert.strictEqual(hostsCommand(['a.b'], '127.0.0.1', 'win32'), '', 'Windows has its own prompt');
  assert.strictEqual(hostsCommand([], '127.0.0.1', 'linux'), '', 'nothing missing, nothing to paste');
});

console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
