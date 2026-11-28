'use strict';

/*
 * The settings: the schema itself, the configuration store built on it, and detection.
 *
 * Plain Node, no Electron and no test framework, like the other tests here:
 *
 *   node tools/test-settings.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SCHEMA, SECTIONS, DEAD_KEYS, RENAMED_KEYS } = require('../src/main/settings-schema');
const { ConfigStore, coerce, importLegacy, defaultOf, getAt } = require('../src/main/config');
const detect = require('../src/main/detect');

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devpanel-settings-'));
let counter = 0;
function tmpDir() {
  counter += 1;
  const dir = path.join(tmpRoot, 'case-' + counter);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function store({ platform = 'linux', detected = {}, file } = {}) {
  return new ConfigStore({
    file: file || path.join(tmpDir(), 'config.json'),
    platform,
    detect: () => detected,
  });
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---------------------------------------------------------------- the schema
console.log('\n--- the schema ---');

test('every entry is complete, in both languages', () => {
  const sections = new Set(SECTIONS.map((s) => s.id));
  for (const e of SCHEMA) {
    assert.ok(e.key && /^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)+$/.test(e.key), 'bad key ' + e.key);
    assert.ok(['file', 'directory', 'string', 'number', 'bool', 'list', 'enum'].includes(e.type), e.key + ': type');
    assert.ok(sections.has(e.section), e.key + ': unknown section ' + e.section);
    for (const field of ['label', 'help']) {
      for (const lang of ['en', 'fr']) {
        assert.ok(e[field] && typeof e[field][lang] === 'string' && e[field][lang].trim(),
          e.key + ': missing ' + field + '.' + lang);
      }
    }
    if (e.type === 'enum') assert.ok(Array.isArray(e.options) && e.options.length, e.key + ': options');
  }
  for (const s of SECTIONS) assert.ok(s.label.en && s.label.fr, 'section ' + s.id + ': label');
});

test('keys are unique', () => {
  const keys = SCHEMA.map((e) => e.key);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('every default is a valid value for its own entry, on both systems', () => {
  for (const platform of ['win32', 'linux']) {
    for (const e of SCHEMA) {
      const value = defaultOf(e, platform);
      if (value === '' || value === undefined) continue;
      const result = coerce(e, value);
      assert.ok(result.ok, e.key + ' (' + platform + '): ' + result.error);
    }
  }
});

test('no default is tied to one machine', () => {
  // A default is what EVERY install starts from: an absolute path or a home folder in there is
  // somebody's machine leaking into everyone's panel.
  for (const platform of ['win32', 'linux']) {
    for (const e of SCHEMA) {
      for (const value of [].concat(defaultOf(e, platform))) {
        if (typeof value !== 'string') continue;
        assert.ok(!/^[A-Za-z]:[\\/]/.test(value), e.key + ': absolute Windows path in a default');
        assert.ok(!/^(\/home\/|\/Users\/|~)/.test(value), e.key + ': home folder in a default');
      }
    }
  }
});

test('a required path can be detected (nobody has to type it on a standard checkout)', () => {
  for (const e of SCHEMA.filter((x) => x.required)) {
    assert.ok(e.detect, e.key + ' is required but has no detector');
    assert.strictEqual(typeof detect.detectAll, 'function');
  }
});

test('dead and renamed keys do not collide with live settings', () => {
  const keys = new Set(SCHEMA.map((e) => e.key));
  for (const dead of DEAD_KEYS) assert.ok(!keys.has(dead), dead + ' is both dead and live');
  for (const [from, to] of Object.entries(RENAMED_KEYS)) {
    assert.ok(!keys.has(from), from + ' was renamed but is still a setting');
    assert.ok(keys.has(to), from + ' is renamed to an unknown setting ' + to);
  }
});

// ---------------------------------------------------------------- coercion
console.log('\n--- values ---');

const entry = (key) => SCHEMA.find((e) => e.key === key);

test('numbers: text is accepted, bounds are enforced, fractions are not', () => {
  const e = entry('godot.clientCount');
  assert.deepStrictEqual(coerce(e, '3'), { ok: true, value: 3 });
  assert.strictEqual(coerce(e, 99).ok, false);
  assert.strictEqual(coerce(e, 0).ok, false);
  assert.strictEqual(coerce(e, 2.5).ok, false);
  assert.strictEqual(coerce(e, 'many').ok, false);
});

test('lists: one item per line, blanks dropped', () => {
  const e = entry('godot.serverArgs');
  assert.deepStrictEqual(coerce(e, ' --a \n\n--b=1\r\n').value, ['--a', '--b=1']);
  assert.deepStrictEqual(coerce(e, ['x', ' y ']).value, ['x', 'y']);
  assert.strictEqual(coerce(e, [1, 2]).ok, false);
});

test('booleans, enums and patterns', () => {
  assert.strictEqual(coerce(entry('api.enabled'), 'false').value, false);
  assert.strictEqual(coerce(entry('api.enabled'), 'yes').ok, false);
  assert.strictEqual(coerce(entry('ui.language'), 'fr').ok, true);
  assert.strictEqual(coerce(entry('ui.language'), 'de').ok, false);
  assert.strictEqual(coerce(entry('k8s.namespace'), 'Not A Namespace').ok, false);
  assert.strictEqual(coerce(entry('k8s.namespace'), 'my-ns').ok, true);
});

// ---------------------------------------------------------------- the store
console.log('\n--- the configuration store ---');

test('with no file: every setting has its default, and nothing is written', () => {
  const s = store().load();
  for (const e of SCHEMA.filter((x) => !x.platforms)) {
    assert.notStrictEqual(getAt(s.config, e.key), undefined, e.key + ' is missing from the configuration');
  }
  assert.strictEqual(s.config.ports.api, 7788);
  assert.strictEqual(fs.existsSync(s.file), false);
  assert.strictEqual(s.problems.length, 0);
});

test('platform-specific settings only exist on their platform', () => {
  const win = store({ platform: 'win32' }).load();
  const lin = store({ platform: 'linux' }).load();
  assert.ok('dockerDesktop' in win.config.paths && !('dockerStartCommand' in win.config.paths));
  assert.ok('dockerStartCommand' in lin.config.paths && !('dockerDesktop' in lin.config.paths));
  assert.strictEqual(win.apply({ 'paths.dockerStartCommand': 'x' }).ok, false);
});

test('the file only keeps what the user chose', () => {
  const s = store().load();
  const r = s.apply({ 'godot.clientCount': 3, 'ports.api': '7790' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.changed.sort(), ['godot.clientCount', 'ports.api']);
  assert.deepStrictEqual(r.restart, ['ports.api']);
  assert.deepStrictEqual(read(s.file), { configVersion: 2, godot: { clientCount: 3 }, ports: { api: 7790 } });

  s.apply({ 'godot.clientCount': 2, 'ports.api': null });   // back to the defaults
  assert.deepStrictEqual(read(s.file), { configVersion: 2 });
});

test('one invalid value and nothing is saved', () => {
  const s = store().load();
  const r = s.apply({ 'godot.clientCount': 4, 'ports.api': 'abc' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors['ports.api']);
  assert.strictEqual(s.config.godot.clientCount, 2);
  assert.strictEqual(fs.existsSync(s.file), false);
});

test('the configuration object is rebuilt in place', () => {
  const s = store().load();
  const held = s.config;                 // what a module was handed at start
  const heldGodot = s.config;            // (modules read through the root object)
  s.apply({ 'godot.clientCount': 5 });
  assert.strictEqual(s.config, held);
  assert.strictEqual(heldGodot.godot.clientCount, 5);
});

test('detection fills what is empty, the user wins, and a removed choice goes back to detection', () => {
  const s = store({ detected: { godotExe: '/opt/godot/Godot_v4_mono', language: 'fr' } }).load();
  assert.strictEqual(s.config.paths.godotExe, '/opt/godot/Godot_v4_mono');
  assert.strictEqual(s.config.ui.language, 'fr');
  assert.strictEqual(fs.existsSync(s.file), false, 'a detected value must never be written');

  s.apply({ 'paths.godotExe': '/mine/godot', 'ui.language': 'en' });
  assert.strictEqual(s.config.paths.godotExe, '/mine/godot');
  assert.strictEqual(s.config.ui.language, 'en', 'choosing the default over a detected value must stick');

  s.apply({ 'paths.godotExe': null });
  assert.strictEqual(s.config.paths.godotExe, '/opt/godot/Godot_v4_mono');
});

test('a choice identical to what is detected stays a choice', () => {
  const s = store({ detected: { godotExe: '/opt/godot/a' } }).load();
  s.apply({ 'paths.godotExe': '/opt/godot/a' });
  assert.strictEqual(read(s.file).paths.godotExe, '/opt/godot/a');
});

test('~ is expanded in paths, and kept as typed in the file', () => {
  const s = store().load();
  s.apply({ 'paths.godotProject': '~/game' });
  assert.strictEqual(s.config.paths.godotProject, path.join(os.homedir(), 'game'));
  assert.strictEqual(read(s.file).paths.godotProject, '~/game');
});

test('required settings that are missing are reported', () => {
  const dir = tmpDir();
  const s = store({ detected: { kubernetesRepo: dir } }).load();
  const missing = s.missingRequired();
  assert.ok(!missing.includes('paths.kubernetesRepo'));
  assert.ok(missing.includes('paths.godotExe') && missing.includes('paths.godotProject'));
  s.apply({ 'paths.godotProject': path.join(dir, 'nowhere') });
  assert.ok(s.missingRequired().includes('paths.godotProject'), 'a path that does not exist is still missing');
});

test('an unknown key is kept in the file and reported, not dropped', () => {
  const file = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ configVersion: 2, future: { thing: 1 }, godot: { clientCount: 3 } }));
  const s = store({ file }).load();
  assert.ok(s.problems.some((p) => p.level === 'warn' && p.key === 'future.thing'));
  s.apply({ 'godot.clientCount': 4 });
  assert.strictEqual(read(file).future.thing, 1);
});

test('an invalid value in the file is reported and the default is used', () => {
  const file = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ configVersion: 2, ports: { api: 'nope' } }));
  const s = store({ file }).load();
  assert.strictEqual(s.config.ports.api, 7788);
  assert.ok(s.problems.some((p) => p.level === 'error' && p.key === 'ports.api'));
});

test('a broken file is reported loudly, set aside, and never silently overwritten', () => {
  const file = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(file, '{ "ports": { "api": 7790, } }');     // trailing comma
  const s = store({ file }).load();
  assert.ok(s.problems.some((p) => p.level === 'error'));
  assert.strictEqual(s.config.ports.api, 7788);
  s.apply({ 'godot.clientCount': 3 });
  assert.ok(fs.existsSync(file + '.broken'), 'the unreadable file must be kept aside');
  assert.ok(fs.readFileSync(file + '.broken', 'utf8').includes('7790'));
});

test('a UTF-8 byte order mark does not make the file unreadable', () => {
  const file = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ configVersion: 2, godot: { clientCount: 4 } }));
  const s = store({ file }).load();
  assert.strictEqual(s.config.godot.clientCount, 4);
  assert.strictEqual(s.problems.length, 0);
});

test('profile and modules are kept next to the settings', () => {
  const s = store().load();
  s.setReserved('profile', 'level-designer');
  s.setReserved('modules', { cluster: false });
  s.apply({ 'godot.clientCount': 3 });
  assert.deepStrictEqual(read(s.file), {
    configVersion: 2, profile: 'level-designer', modules: { cluster: false }, godot: { clientCount: 3 },
  });
  const again = store({ file: s.file }).load();
  assert.strictEqual(again.config.profile, 'level-designer');
  assert.deepStrictEqual(again.config.modules, { cluster: false });
});

// ---------------------------------------------------------------- importing an older file
console.log('\n--- a config.json from an earlier version ---');

const LEGACY = {
  paths: {
    gitBash: 'X:\\tools\\bash.exe',
    godotExe: 'X:\\godot\\godot_console.exe',
    kubernetesRepo: 'X:\\ws\\kubernetes',
    devShCwdPosix: '/x/ws/kubernetes',
  },
  k8s: { namespace: 'dyingstar', expectedContext: 'k3d-dyingstar', traefikNamespace: 'traefik', argoNamespace: 'argocd' },
  ports: { horizon: 7040, gameServer: 8980, api: 7788 },
  godot: { clientWidth: 1720, clientHeight: 1440, clientCount: 2, clientArgs: [] },
  timeouts: { skaffoldReadyMs: 600000, dockerReadyMs: 240000 },
  api: { enabled: true, host: '127.0.0.1' },
  npc: { repo: 'X:\\ws\\npc', container: 'app' },
};

test('dead keys go, renamed keys move, copies of the defaults are dropped, choices stay', () => {
  const flat = importLegacy(LEGACY, 'win32');
  assert.deepStrictEqual(flat, {
    'paths.godotExe': 'X:\\godot\\godot_console.exe',
    'paths.kubernetesRepo': 'X:\\ws\\kubernetes',
    'godot.clientWidth': 1720,
    'godot.clientHeight': 1440,
    'timeouts.stackReadyMs': 600000,
  });
});

test('the import happens once, keeps a .bak, and leaves a current-format file', () => {
  const file = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(file, JSON.stringify(LEGACY, null, 2));
  const s = store({ file, platform: 'win32' }).load();
  assert.strictEqual(s.importedLegacy, true);
  assert.strictEqual(s.config.timeouts.stackReadyMs, 600000);
  assert.strictEqual(s.config.godot.clientWidth, 1720);
  assert.strictEqual(s.problems.length, 0, JSON.stringify(s.problems));
  assert.ok(read(file + '.bak').npc, 'the original file must be kept as .bak');
  assert.strictEqual(read(file).configVersion, 2);
  assert.strictEqual(read(file).npc, undefined);

  const again = store({ file, platform: 'win32' }).load();
  assert.strictEqual(again.importedLegacy, false);
});

// ---------------------------------------------------------------- detection
console.log('\n--- detection ---');

function touch(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('which() finds a tool on PATH, with the extensions Windows expects', () => {
  const bin = tmpDir();
  touch(path.join(bin, 'kubectl'));
  touch(path.join(bin, 'k3d.exe'));
  touch(path.join(bin, 'helm.cmd'));
  const posix = { env: { PATH: bin }, platform: 'linux' };
  const win = { env: { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, platform: 'win32' };

  assert.strictEqual(detect.which('kubectl', posix).path, path.join(bin, 'kubectl'));
  assert.strictEqual(detect.which('docker', posix), null);
  assert.strictEqual(detect.which('k3d', win).path, path.join(bin, 'k3d.exe'));
  assert.strictEqual(detect.which('k3d', win).shim, false);
  assert.strictEqual(detect.which('helm', win).shim, true, 'a .cmd wrapper must be flagged');
});

test('the repositories and Godot are found in the layout the repository itself assumes', () => {
  const ws = tmpDir();
  touch(path.join(ws, 'kubernetes', 'dev-projects.yaml'), 'projects:\n');
  touch(path.join(ws, 'kubernetes', 'devpanel', 'package.json'), '{}');
  touch(path.join(ws, 'SomeOtherGame', 'project.godot'));
  touch(path.join(ws, 'DyingStar', 'project.godot'));
  const godotDir = path.join(ws, 'Godot', 'Godot_v4.7-stable_mono_win64');
  touch(path.join(godotDir, 'Godot_v4.7-stable_mono_win64.exe'));
  touch(path.join(godotDir, 'Godot_v4.7-stable_mono_win64_console.exe'));
  touch(path.join(godotDir, 'GodotSharp', 'Tools', 'nupkgs', 'x.nupkg'));
  const linuxDir = path.join(ws, 'Godot', 'Godot_v4.7-stable_mono_linux_x86_64');
  touch(path.join(linuxDir, 'Godot_v4.7-stable_mono_linux.x86_64'));

  const appRoot = path.join(ws, 'kubernetes', 'devpanel');   // the panel run from inside the repository
  const win = detect.detectAll({ appRoot, platform: 'win32', env: {}, locale: 'fr-FR' });
  assert.strictEqual(win.kubernetesRepo, path.join(ws, 'kubernetes'));
  assert.strictEqual(win.godotProject, path.join(ws, 'DyingStar'), 'the game wins over another Godot project');
  assert.strictEqual(win.godotExe, path.join(godotDir, 'Godot_v4.7-stable_mono_win64_console.exe'),
    'the console build is the one whose output can be read');
  assert.strictEqual(win.godotSharpNupkgs, path.join(godotDir, 'GodotSharp', 'Tools', 'nupkgs'));
  assert.strictEqual(win.language, 'fr');

  const lin = detect.detectAll({ appRoot, platform: 'linux', env: {}, locale: 'en-US' });
  assert.strictEqual(lin.godotExe, path.join(linuxDir, 'Godot_v4.7-stable_mono_linux.x86_64'));
  assert.strictEqual(lin.language, 'en');
});

test('choosing the repository by hand is enough for the rest to be found around it', () => {
  const ws = tmpDir();
  touch(path.join(ws, 'kubernetes', 'dev-projects.yaml'));
  touch(path.join(ws, 'DyingStar', 'project.godot'));
  const elsewhere = tmpDir();                                   // an installed panel: nothing around it
  const none = detect.detectAll({ appRoot: elsewhere, platform: 'linux', env: {} });
  assert.strictEqual(none.kubernetesRepo, null);
  assert.strictEqual(none.godotProject, null);
  const known = detect.detectAll({
    appRoot: elsewhere, platform: 'linux', env: {},
    known: { 'paths.kubernetesRepo': path.join(ws, 'kubernetes') },
  });
  assert.strictEqual(known.godotProject, path.join(ws, 'DyingStar'));
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
