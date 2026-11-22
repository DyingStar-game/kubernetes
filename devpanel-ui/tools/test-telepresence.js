'use strict';

/*
 * Telepresence: reading its status, and the commands the buttons run.
 *
 *   node tools/test-telepresence.js
 *
 * The two status documents below are what the 2.28 client really prints (shortened; the machine's
 * own path and install id removed).
 */

const assert = require('node:assert');
const { Telepresence, parseStatus, isIntercepted, mayList, minorOf } = require('../src/main/telepresence');

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

const NOT_CONNECTED = '{"user_daemon":{"running":false,"in_docker":false,"daemon_port":0},'
  + '"root_daemon":{"running":false,"api_version":0,"managed":false},'
  + '"traffic_manager":{"name":"","traffic_agent":"","version":""}}';

const CONNECTED = '{"user_daemon":{"name":"minikube-dyingstar","daemon_port":0,'
  + '"kubernetes_server":"https://127.0.0.1:52094","manager_namespace":"telepresence",'
  + '"mapped_namespaces":["argocd","default","dyingstar"],"running":true,"version":"2.28.0",'
  + '"status":"Connected","kubernetes_context":"minikube","namespace":"dyingstar","in_docker":false},'
  + '"root_daemon":{"running":true,"name":"OSS User Daemon","version":"v2.28.0","api_version":3},'
  + '"traffic_manager":{"version":"v2.28.0","name":"OSS Traffic Manager","traffic_agent":"ghcr.io/telepresenceio/tel2:2.28.0"}}';

test('not connected', () => {
  const s = parseStatus(NOT_CONNECTED);
  assert.strictEqual(s.connected, false);
  assert.strictEqual(s.mismatch, false);
});

test('connected: namespace, context and versions are read', () => {
  const s = parseStatus(CONNECTED);
  assert.strictEqual(s.connected, true);
  assert.strictEqual(s.namespace, 'dyingstar');
  assert.strictEqual(s.context, 'minikube');
  assert.strictEqual(s.clientVersion, '2.28.0');
  assert.strictEqual(s.managerVersion, 'v2.28.0');
  assert.strictEqual(s.mismatch, false, '2.28.0 and v2.28.0 are the same version');
});

test('a client that does not match the cluster\'s traffic manager is flagged', () => {
  const s = parseStatus(CONNECTED.replace('"version":"2.28.0"', '"version":"2.33.2"'));
  assert.strictEqual(s.mismatch, true);
  assert.strictEqual(minorOf('v2.28.7'), '2.28');
  assert.strictEqual(minorOf(''), '');
});

test('an interception is read from the list, for the right workload only', () => {
  const LIST = [
    'deployment dyingstar-admin             : ready to engage (traffic-agent not yet installed)',
    'deployment godotserver                 : intercepted',
    '   Intercept name: godotserver',
    '   State         : ACTIVE',
    '   Intercepting  : 10.244.3.184 -> 127.0.0.1',
    '       8980 -> 8980 TCP',
    'deployment horizon                     : ready to engage (traffic-agent not yet installed)',
  ].join('\r\n');
  assert.strictEqual(isIntercepted(LIST, 'godotserver'), true);
  assert.strictEqual(isIntercepted(LIST, 'horizon'), false);
  assert.strictEqual(isIntercepted(LIST.replace(': intercepted', ': ready to engage'), 'godotserver'), false);
  assert.strictEqual(isIntercepted('', 'godotserver'), false);
});

test('the list is only asked of a session at our namespace: asked of none, it connects to another', () => {
  assert.strictEqual(mayList({ connected: true, namespace: 'dyingstar' }, 'dyingstar'), true);
  assert.strictEqual(mayList({ connected: true, namespace: 'default' }, 'dyingstar'), false);
  assert.strictEqual(mayList({ connected: false, namespace: 'dyingstar' }, 'dyingstar'), false);
  assert.strictEqual(mayList(null, 'dyingstar'), false);
});

test('garbage is not a status', () => {
  assert.strictEqual(parseStatus('telepresence: command not found'), null);
});

test('the buttons run the commands of the README, on the configured namespace and port', () => {
  const started = [];
  const tp = new Telepresence({
    config: { k8s: { namespace: 'my-ns' }, ports: { gameServer: 8980 } },
    log: { note() {} },
    procs: { start: (spec) => { started.push(spec); return spec; } },
  });
  tp.intercept();
  tp.leave();
  tp.quit();
  assert.deepStrictEqual(started.map((s) => s.args), [
    ['intercept', 'godotserver', '--port', '8980', '--mount=false'],
    ['leave', 'godotserver'],
    ['quit', '-s'],
  ]);
  assert.ok(started.every((s) => s.cmd === 'telepresence' && s.source === 'telepresence'));

  tp.connect();
  const connect = started[started.length - 1];
  assert.ok(connect.args.join(' ').includes('my-ns'), 'connect targets the configured namespace');
});

console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
