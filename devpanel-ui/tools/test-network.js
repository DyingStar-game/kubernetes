'use strict';

/*
 * The relay network path: which relays a cluster needs, when an existing one is good enough, and
 * what the hosts file must say. Pure: no Docker, no cluster, no file is touched.
 *
 *   node tools/test-network.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  IMAGE, relayAddresses, buildRelaySpecs, dockerRunArgs, diffRelay, planHosts, isHostName,
} = require('../src/main/network');

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

const FACTS = { subnet: '192.168.49.0/24', nodeIp: '192.168.49.2', httpNodePort: 30257, httpsNodePort: 31854, udpNodePort: 30101 };

/** What `docker inspect` returns for a relay made exactly like `spec`. */
function inspectOf(spec, { running = true } = {}) {
  return {
    Config: { Image: spec.image, Cmd: [...spec.cmd] },
    HostConfig: { PortBindings: { [spec.bind.container]: [{ HostIp: '127.0.0.1', HostPort: spec.bind.hostPort }] } },
    NetworkSettings: { Networks: { minikube: { IPAMConfig: { IPv4Address: spec.ip } } } },
    State: { Running: running },
  };
}

console.log('\n--- which relays ---');

test('the relays get fixed addresses at the top of the range, never the node\'s', () => {
  assert.deepStrictEqual(relayAddresses('192.168.49.0/24'), { udp: '192.168.49.250', http: '192.168.49.251', https: '192.168.49.252' });
  assert.deepStrictEqual(relayAddresses('10.20.0.0/16'), { udp: '10.20.255.250', http: '10.20.255.251', https: '10.20.255.252' });
  assert.strictEqual(relayAddresses('garbage'), null);
  assert.strictEqual(relayAddresses(''), null);
});

test('one relay per door, pointing at the ports READ from the cluster', () => {
  const specs = buildRelaySpecs(FACTS);
  assert.deepStrictEqual(specs.map((s) => s.name), ['traefik-http-relay', 'traefik-https-relay', 'horizon-wt-relay']);
  assert.deepStrictEqual(specs[0].cmd, ['TCP-LISTEN:80,fork,reuseaddr', 'TCP:192.168.49.2:30257']);
  assert.deepStrictEqual(specs[1].cmd, ['TCP-LISTEN:443,fork,reuseaddr', 'TCP:192.168.49.2:31854']);
  assert.deepStrictEqual(specs[2].cmd, ['-d', 'UDP4-LISTEN:30101,fork,reuseaddr', 'UDP4:192.168.49.2:30101']);
  assert.ok(specs.every((s) => s.image === IMAGE));
});

test('a door the cluster does not have gets no relay; an unreadable cluster gets none at all', () => {
  assert.deepStrictEqual(buildRelaySpecs({ ...FACTS, udpNodePort: null }).map((s) => s.name),
    ['traefik-http-relay', 'traefik-https-relay']);
  assert.deepStrictEqual(buildRelaySpecs({ ...FACTS, nodeIp: '' }), []);
  assert.deepStrictEqual(buildRelaySpecs({ ...FACTS, subnet: '' }), []);
});

test('a relay is only ever published on this machine (127.0.0.1), and restarts with Docker', () => {
  for (const spec of buildRelaySpecs(FACTS)) {
    const args = dockerRunArgs(spec);
    const publish = args[args.indexOf('-p') + 1];
    assert.ok(publish.startsWith('127.0.0.1:'), spec.name + ' publishes ' + publish);
    assert.strictEqual(args[args.indexOf('--restart') + 1], 'unless-stopped');
    assert.strictEqual(args[args.indexOf('--ip') + 1], spec.ip);
    assert.strictEqual(args[args.indexOf('--network') + 1], 'minikube');
  }
  assert.strictEqual(dockerRunArgs(buildRelaySpecs(FACTS)[2])[dockerRunArgs(buildRelaySpecs(FACTS)[2]).indexOf('-p') + 1],
    '127.0.0.1:30101:30101/udp');
});

console.log('\n--- an existing relay ---');

const [http] = buildRelaySpecs(FACTS);

test('one made the same way is adopted as it is', () => {
  assert.strictEqual(diffRelay(inspectOf(http), http), 'keep');
});

test('none: create. Stopped: start', () => {
  assert.strictEqual(diffRelay(null, http), 'create');
  assert.strictEqual(diffRelay(inspectOf(http, { running: false }), http), 'start');
});

test('a recreated cluster (new port, new node address) means a recreated relay', () => {
  const [moved] = buildRelaySpecs({ ...FACTS, httpNodePort: 31999 });
  assert.strictEqual(diffRelay(inspectOf(http), moved), 'recreate');
  const [renumbered] = buildRelaySpecs({ ...FACTS, nodeIp: '192.168.49.3' });
  assert.strictEqual(diffRelay(inspectOf(http), renumbered), 'recreate');
});

test('no fixed address, or published on every interface: replaced', () => {
  const floating = inspectOf(http);
  floating.NetworkSettings.Networks.minikube.IPAMConfig = null;
  assert.strictEqual(diffRelay(floating, http), 'recreate', 'a relay without a fixed address can steal the node\'s');
  const open = inspectOf(http);
  open.HostConfig.PortBindings['80/tcp'][0].HostIp = '0.0.0.0';
  assert.strictEqual(diffRelay(open, http), 'recreate', 'a relay must not be reachable from the network');
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

console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
