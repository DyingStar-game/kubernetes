'use strict';

/*
 * The player tokens of the game clients the panel launches: a real Keycloak client (dyingstar-dev,
 * never admin-cli: it yields an empty "lightweight" token), one test account per client instance,
 * the token given to the instance as --token=, and a client that still starts when Keycloak does
 * not answer. Keycloak is replaced by a fake fetch: nothing leaves the machine.
 *
 *   node tools/test-devtoken.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DevToken, TEST_PLAYERS } = require('../src/main/devtoken');
const { Godot } = require('../src/main/godot');

let passed = 0;
let failed = 0;

async function test(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  OK    ' + title);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + title);
    console.log('        ' + (err && err.stack || err));
  }
}

const jwt = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
const future = () => Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const CONFIG = () => ({
  auth: { playerTokens: true, tokenUrl: 'http://auth.test/realms/dyingstar/protocol/openid-connect/token', clientId: 'dyingstar-dev' },
  paths: { godotExe: '/opt/godot', godotProject: '/proj' },
  godot: { clientWidth: 800, clientHeight: 600, clientArgs: [] },
});
const notes = [];
const LOG = { note: (text, level) => notes.push({ text, level }) };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devpanel-tok-'));

/** Keycloak stand-in: records the forms it gets, answers a token for the user it is asked for. */
function fakeKeycloak({ fail = false } = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push({ url, form });
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ access_token: jwt({ preferred_username: form.username, sub: 'x', exp: future() }) }) };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

(async () => {
  await test('the token comes from the dev client, with the test account as user and password', async () => {
    const kc = fakeKeycloak();
    try {
      const dt = new DevToken({ runtimeDir: tmp(), log: LOG, config: CONFIG() });
      const token = await dt.tokenFor('player-kira');
      assert.ok(token);
      const { url, form } = kc.calls[0];
      assert.ok(url.endsWith('/protocol/openid-connect/token'));
      assert.strictEqual(form.client_id, 'dyingstar-dev');
      assert.notStrictEqual(form.client_id, 'admin-cli', 'admin-cli gives a token with no user claims');
      assert.strictEqual(form.grant_type, 'password');
      assert.strictEqual(form.username, 'player-kira');
      assert.strictEqual(form.password, 'player-kira');
    } finally { kc.restore(); }
  });

  await test('a token is reused until a day before it expires', async () => {
    const kc = fakeKeycloak();
    try {
      const dt = new DevToken({ runtimeDir: tmp(), log: LOG, config: CONFIG() });
      const a = await dt.tokenFor('player-orin');
      const b = await dt.tokenFor('player-orin');
      assert.strictEqual(a, b);
      assert.strictEqual(kc.calls.length, 1, 'the second ask is served from the cache');
    } finally { kc.restore(); }
  });

  await test('each client instance plays as its own account', () => {
    assert.strictEqual(DevToken.playerFor(0), TEST_PLAYERS[0]);
    assert.notStrictEqual(DevToken.playerFor(0), DevToken.playerFor(1));
    assert.strictEqual(DevToken.playerFor(TEST_PLAYERS.length), TEST_PLAYERS[0], 'wraps around');
  });

  await test('the client instance gets the token as --token=, and its own position', async () => {
    const kc = fakeKeycloak();
    try {
      const started = [];
      const procs = { start: (spec) => { started.push(spec); return { ok: true }; } };
      const godot = new Godot({ config: CONFIG(), log: LOG, procs, runtimeDir: tmp() });
      await godot.startClient(1);
      const args = started[0].args;
      const arg = args.find((a) => a.startsWith('--token='));
      assert.ok(arg, 'no --token= in ' + args.join(' '));
      const claims = JSON.parse(Buffer.from(arg.slice(8).split('.')[1], 'base64url').toString('utf8'));
      assert.strictEqual(claims.preferred_username, DevToken.playerFor(1), 'instance 2 plays as account 2');
      assert.strictEqual(args[args.indexOf('--position') + 1], '800,0');
    } finally { kc.restore(); }
  });

  await test('Keycloak down: the client still starts, without a token, and says so', async () => {
    const kc = fakeKeycloak({ fail: true });
    try {
      const started = [];
      const godot = new Godot({ config: CONFIG(), log: LOG, procs: { start: (s) => { started.push(s); return { ok: true }; } }, runtimeDir: tmp() });
      await godot.startClient(0);
      assert.ok(!started[0].args.some((a) => a.startsWith('--token=')));
      assert.ok(notes.some((n) => /WITHOUT a token/.test(n.text) && n.level === 'WARN'));
    } finally { kc.restore(); }
  });

  await test('the setting can switch player tokens off', async () => {
    const kc = fakeKeycloak();
    try {
      const cfg = CONFIG();
      cfg.auth.playerTokens = false;
      const dt = new DevToken({ runtimeDir: tmp(), log: LOG, config: cfg });
      assert.strictEqual(await dt.tokenFor('player-kira'), null);
      assert.strictEqual(kc.calls.length, 0);
    } finally { kc.restore(); }
  });

  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
  process.exit(failed ? 1 : 0);
})();
