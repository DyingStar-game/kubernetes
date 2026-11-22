'use strict';

/*
 * Modules and profiles: what is on, what a profile file may contain, and that the window, the
 * start chain and the actions all speak of the same modules.
 *
 *   node tools/test-modules.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MODULES, MODULE_IDS, resolveModules, validateProfile, loadProfiles } = require('../src/main/modules');
const { STEPS, Services } = require('../src/main/services');
const { Probes } = require('../src/main/probes');
const { ConfigStore } = require('../src/main/config');

let passed = 0;
let failed = 0;
const pending = [];

function test(title, fn) {
  const done = (err) => {
    if (err) {
      failed += 1;
      console.log('  FAIL  ' + title);
      console.log('        ' + (err && err.message));
    } else {
      passed += 1;
      console.log('  OK    ' + title);
    }
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(() => done(), done));
    else done();
  } catch (err) {
    done(err);
  }
}

const ROOT = path.join(__dirname, '..');
const onIds = (resolved) => MODULE_IDS.filter((id) => resolved[id].on);

console.log('\n--- the table of modules ---');

test('every module is complete, in both languages, and only requires modules that exist', () => {
  for (const m of MODULES) {
    assert.ok(/^[a-zA-Z]+$/.test(m.id), 'id ' + m.id);
    for (const field of ['label', 'help']) {
      assert.ok(m[field].en && m[field].fr, m.id + ': ' + field);
    }
    for (const req of m.requires) assert.ok(MODULE_IDS.includes(req), m.id + ' requires unknown ' + req);
  }
  assert.strictEqual(new Set(MODULE_IDS).size, MODULE_IDS.length);
});

console.log('\n--- which modules run ---');

test('no profile: everything is on (what the panel did before profiles)', () => {
  assert.deepStrictEqual(onIds(resolveModules(null, {})), MODULE_IDS);
});

test('turning a module off turns off what needs it, and nothing else', () => {
  const r = resolveModules(null, { cluster: false });
  assert.deepStrictEqual(onIds(r), ['docker', 'gameServer', 'clients', 'editor']);
  assert.deepStrictEqual(r.telepresence.blockedBy, ['cluster']);
  assert.deepStrictEqual(r.relink.blockedBy, ['horizon']);
  assert.strictEqual(r.relink.wanted, true, 'still wanted: it comes back with the cluster');
});

test('forcing a module on never switches on what it needs', () => {
  const profile = { clients: true, editor: true };
  const r = resolveModules(profile, { relink: true });
  assert.strictEqual(r.relink.on, false);
  assert.deepStrictEqual(r.relink.blockedBy.sort(), ['gameServer', 'horizon']);
  assert.deepStrictEqual(onIds(r), ['clients', 'editor']);
});

test('an override wins over the profile, both ways', () => {
  const profile = { docker: true, cluster: true, build: true };
  const r = resolveModules(profile, { build: false, editor: true });
  assert.strictEqual(r.build.on, false);
  assert.strictEqual(r.build.overridden, true);
  assert.strictEqual(r.editor.on, true);
  assert.strictEqual(r.docker.overridden, false);
});

console.log('\n--- profile files ---');

test('the shipped profiles are valid and say something about every module', () => {
  const { profiles, problems } = loadProfiles([path.join(ROOT, 'profiles')]);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual([...profiles.keys()].sort(), ['developer', 'gameserver-developer', 'level-designer']);
  for (const p of profiles.values()) {
    assert.deepStrictEqual(Object.keys(p.modules).sort(), [...MODULE_IDS].sort(), p.id + ' must list every module');
    assert.ok(p.name.en && p.name.fr && p.description.en && p.description.fr, p.id + ': texts');
    // A profile must not ask for a module whose requirements it switches off.
    const r = resolveModules(p.modules, {});
    for (const id of MODULE_IDS) assert.strictEqual(r[id].on, p.modules[id], p.id + ': ' + id + ' is blocked');
  }
});

test('the standard profile works on the repository as it is (no local game server)', () => {
  const { profiles } = loadProfiles([path.join(ROOT, 'profiles')]);
  const dev = profiles.get('developer').modules;
  assert.strictEqual(dev.gameServer, false);
  assert.strictEqual(dev.relink, false);
  assert.strictEqual(dev.cluster, true);
});

test('the settings a shipped profile asks for are real settings', () => {
  const { profiles } = loadProfiles([path.join(ROOT, 'profiles')]);
  for (const p of profiles.values()) {
    const store = new ConfigStore({ file: path.join(os.tmpdir(), 'devpanel-none', 'config.json') }).load();
    assert.deepStrictEqual(store.setProfileSettings(p.settings), [], p.id);
  }
});

test('a hand-written profile with a mistake is refused with the reason', () => {
  assert.strictEqual(validateProfile({ id: 'x', modules: { cluster: true } }).ok, true);
  assert.ok(/unknown module/.test(validateProfile({ id: 'x', modules: { clustre: true } }).error));
  assert.ok(/true or false/.test(validateProfile({ id: 'x', modules: { cluster: 'yes' } }).error));
  assert.ok(/modules/.test(validateProfile({ id: 'x' }).error));
  assert.ok(/id/.test(validateProfile({ id: 'Bad Id', modules: {} }).error));
});

test('a profile may name the service sets to deploy; core is always there, unknown ones are refused', () => {
  assert.strictEqual(validateProfile({ id: 'x', modules: {} }).profile.sets, null, 'absent: every set');
  assert.deepStrictEqual(validateProfile({ id: 'x', modules: {}, sets: [] }).profile.sets, ['core']);
  assert.deepStrictEqual(validateProfile({ id: 'x', modules: {}, sets: ['telepresence', 'gameplay'] }).profile.sets,
    ['core', 'gameplay', 'telepresence']);
  assert.ok(/unknown set/.test(validateProfile({ id: 'x', modules: {}, sets: ['nope'] }).error));
  assert.ok(/list/.test(validateProfile({ id: 'x', modules: {}, sets: 'core' }).error));
  const { profiles } = loadProfiles([path.join(ROOT, 'profiles')]);
  assert.deepStrictEqual(profiles.get('level-designer').sets, ['core'], 'the minimum: no game services');
  assert.strictEqual(profiles.get('level-designer').modules.cluster, true);
  assert.ok(profiles.get('gameserver-developer').sets.includes('telepresence'));
});

test('your own profile replaces the shipped one of the same id; a broken file is reported, not fatal', () => {
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'devpanel-profiles-'));
  fs.writeFileSync(path.join(mine, 'developer.json'), JSON.stringify({ name: { en: 'Mine' }, modules: { editor: true } }));
  fs.writeFileSync(path.join(mine, 'broken.json'), '{ nope');
  const { profiles, problems } = loadProfiles([path.join(ROOT, 'profiles'), mine]);
  assert.strictEqual(profiles.get('developer').name.en, 'Mine');
  assert.strictEqual(profiles.get('developer').name.fr, 'Mine', 'a missing language falls back to the other');
  assert.strictEqual(problems.length, 1);
  assert.ok(profiles.has('level-designer'));
  fs.rmSync(mine, { recursive: true, force: true });
});

test('a profile setting sits between detection and the user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpanel-cfg-'));
  const store = new ConfigStore({ file: path.join(dir, 'config.json') }).load();
  store.setProfileSettings({ godot: { clientCount: 1 } });
  assert.strictEqual(store.config.godot.clientCount, 1);
  store.apply({ 'godot.clientCount': 4 });
  assert.strictEqual(store.config.godot.clientCount, 4);
  store.apply({ 'godot.clientCount': null });
  assert.strictEqual(store.config.godot.clientCount, 1, 'removing the user value goes back to the profile');
  assert.deepStrictEqual(store.setProfileSettings({ nope: { x: 1 }, godot: { clientCount: 99 } }).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n--- everything speaks of the same modules ---');

test('every step of the start chain belongs to a known module', () => {
  for (const step of STEPS) assert.ok(MODULE_IDS.includes(step.module), step.id + ' -> ' + step.module);
});

test('every data-module in the page names known modules', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const used = [...html.matchAll(/data-module="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  assert.ok(used.length > 5);
  for (const id of used) assert.ok(MODULE_IDS.includes(id), 'unknown module in the page: ' + id);
});

test('every action tied to a module names a known one', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const table = main.slice(main.indexOf('const ACTION_MODULE = {'), main.indexOf('async function doAction('));
  const owners = [...table.matchAll(/'[a-z-]+':\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(owners.length > 15);
  for (const id of owners) assert.ok(MODULE_IDS.includes(id), 'unknown module for an action: ' + id);
});

console.log('\n--- a module that is off does nothing ---');

test('the chain only shows the steps of modules that are on', () => {
  const chain = (modules) => new Services({
    config: {}, log: { note() {} }, procs: {}, probes: {}, godot: {}, relink: {}, modules,
  }).chainState().steps.map((s) => s.id);

  assert.deepStrictEqual(
    chain({ docker: true, cluster: false, network: false, telepresence: false, gameServer: true, relink: false }),
    ['docker', 'godot-server']);
  // Telepresence connects after the stack and intercepts after the local server listens.
  assert.deepStrictEqual(
    chain({ docker: true, cluster: true, telepresence: true, gameServer: true, relink: true }),
    ['docker', 'minikube', 'context', 'stack', 'network', 'telepresence', 'godot-server', 'intercept', 'relink']);
  // No local server to send the traffic to: connecting still makes sense, intercepting does not.
  assert.deepStrictEqual(
    chain({ docker: true, cluster: true, network: false, telepresence: true, gameServer: false, relink: false }),
    ['docker', 'minikube', 'context', 'stack', 'telepresence']);
});

test('a module that is off is not probed at all', async () => {
  const modules = { docker: false, cluster: false, horizon: false, gameServer: false };
  const probes = new Probes({ k8s: {}, ports: {} }, modules);
  for (const name of ['docker', 'minikube', 'kubeContext', 'pods', 'horizonRoute', 'gameServer']) {
    probes[name] = () => { throw new Error(name + ' was probed'); };
  }
  const all = await probes.all();
  for (const name of ['docker', 'minikube', 'kubeContext', 'pods', 'horizonRoute', 'gameServer']) {
    assert.strictEqual(all[name].off, true, name);
  }
});

Promise.all(pending).then(() => {
  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
  process.exit(failed ? 1 : 0);
});
