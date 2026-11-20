'use strict';

/*
 * The setup assistant: what it reports about a machine, and what it refuses to do.
 * Offline: nothing is downloaded or cloned here.
 *
 *   node tools/test-setup.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Setup, SYSTEM_TOOLS, godotVersionOf, reposFor } = require('../src/main/setup');
const catalog = require('../src/main/repos.json');
const { MODULE_IDS } = require('../src/main/modules');

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
    console.log('        ' + (err && err.message));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpanel-setup-'));
const touch = (file, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function makeSetup({ paths = {}, modules = null, fetchImpl } = {}) {
  const started = [];
  const setup = new Setup({
    config: { paths: { workspace: '', kubernetesRepo: '', godotProject: '', godotExe: '', godotSharpNupkgs: '', ...paths } },
    log: { note() {} },
    procs: { isRunning: () => false, start: (spec) => { started.push(spec); return spec; } },
    toolchain: { checkAll: async () => [{ id: 'kubectl', ok: true, version: '1.35.1' }], cacheDir: path.join(tmp, 'cache') },
    modules,
    fetchImpl,
  });
  return { setup, started };
}

(async () => {
  console.log('\n--- the catalog ---');

  await test('every repository has an https address, a folder, and names real modules', () => {
    const folders = new Set();
    for (const repo of catalog.repos) {
      assert.ok(/^https:\/\/github\.com\/[\w-]+\/[\w.-]+\.git$/.test(repo.url), repo.id + ': url');
      assert.ok(/^[\w.-]+$/.test(repo.folder), repo.id + ': folder');
      assert.ok(!folders.has(repo.folder), repo.folder + ' used twice');
      folders.add(repo.folder);
      for (const m of repo.neededBy) assert.ok(MODULE_IDS.includes(m), repo.id + ' names unknown module ' + m);
    }
    assert.ok(catalog.repos.find((r) => r.id === 'kubernetes').always, 'everything is found around kubernetes');
  });

  await test('a program that needs an installer says where to get it on both systems', () => {
    for (const tool of SYSTEM_TOOLS) {
      assert.ok(tool.winget && /^https:\/\//.test(tool.url) && tool.linux, tool.id);
    }
  });

  console.log('\n--- what a profile needs ---');

  await test('only the repositories the modules in use need are asked for', () => {
    const ids = (modules) => reposFor(modules).map((r) => r.id);
    assert.deepStrictEqual(ids(null), ['kubernetes', 'game', 'horizonserver', 'services']);
    assert.deepStrictEqual(
      ids({ cluster: true, editor: false, clients: false, gameServer: false, build: false }), ['kubernetes']);
    assert.deepStrictEqual(
      ids({ cluster: false, editor: true, clients: true, gameServer: false, build: false }), ['kubernetes', 'game']);
  });

  await test('the Godot version is read from the game project', () => {
    const file = path.join(tmp, 'p', 'project.godot');
    touch(file, '[application]\r\nconfig/name="X"\r\nconfig/features=PackedStringArray("4.7", "C#", "Double Precision")\r\n');
    assert.strictEqual(godotVersionOf(file), '4.7');
    assert.strictEqual(godotVersionOf(path.join(tmp, 'nowhere', 'project.godot')), null);
  });

  console.log('\n--- what it reports ---');

  await test('an empty machine: nothing is there, and the workspace is to choose', async () => {
    const { setup } = makeSetup();
    const s = await setup.status();
    assert.strictEqual(s.workspaceOk, false);
    assert.ok(s.repos.every((r) => r.ok === false));
    assert.strictEqual(s.godot.ok, false);
  });

  await test('a clone is only "there" when it is a repository, with the file that proves which one', async () => {
    const ws = path.join(tmp, 'ws1');
    touch(path.join(ws, 'kubernetes', '.git', 'HEAD'));
    fs.mkdirSync(path.join(ws, 'DyingStar', '.git'), { recursive: true });   // a clone, but no project.godot
    fs.mkdirSync(path.join(ws, 'services'), { recursive: true });            // a folder, not a clone
    const { setup } = makeSetup({ paths: { workspace: ws } });
    const byId = Object.fromEntries((await setup.status()).repos.map((r) => [r.id, r.ok]));
    assert.deepStrictEqual(byId, { kubernetes: true, game: false, horizonserver: false, services: false });
  });

  await test('a checkout under another name is recognised through the settings', async () => {
    const ws = path.join(tmp, 'ws2');
    touch(path.join(ws, 'my-game', '.git', 'HEAD'));
    touch(path.join(ws, 'my-game', 'project.godot'), 'config/features=PackedStringArray("4.7")\n');
    const { setup } = makeSetup({ paths: { workspace: ws, godotProject: path.join(ws, 'my-game') } });
    const s = await setup.status();
    assert.strictEqual(s.repos.find((r) => r.id === 'game').ok, true);
    assert.strictEqual(s.godot.wanted, '4.7');
  });

  await test('Godot is not asked of a profile that never starts it', async () => {
    const off = { editor: false, clients: false, gameServer: false };
    assert.strictEqual((await makeSetup({ modules: off }).setup.status()).godot.needed, false);
    assert.strictEqual((await makeSetup({ modules: { ...off, editor: true } }).setup.status()).godot.needed, true);
  });

  console.log('\n--- what it refuses ---');

  await test('cloning needs a workspace, and never touches a folder that exists', async () => {
    assert.ok(/workspace/.test(makeSetup().setup.cloneRepo('kubernetes').detail));
    const ws = path.join(tmp, 'ws3');
    fs.mkdirSync(path.join(ws, 'kubernetes'), { recursive: true });
    const { setup, started } = makeSetup({ paths: { workspace: ws } });
    const r = setup.cloneRepo('kubernetes');
    assert.strictEqual(r.ok, false);
    assert.ok(/already exists/.test(r.detail));
    assert.strictEqual(started.length, 0, 'git must not have been started');
    assert.strictEqual(setup.cloneRepo('nope').ok, false);
  });

  await test('a clone runs git with the submodules when the repository has some', async () => {
    const ws = path.join(tmp, 'ws4');
    const { setup, started } = makeSetup({ paths: { workspace: ws } });
    const r = setup.cloneRepo('horizonserver');
    if (!r.ok) {
      assert.ok(/git is not installed/.test(r.detail), r.detail);   // a machine without git: said, not thrown
      return;
    }
    assert.strictEqual(started[0].cmd, 'git');
    assert.ok(started[0].args.includes('--recurse-submodules'));
    assert.strictEqual(started[0].args[started[0].args.length - 1], path.join(ws, 'horizonserver'));
  });

  await test('a Godot release with no checksum, or none for this system, is refused', async () => {
    const reply = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 404, json: async () => body });
    const assetName = 'Godot_v9_' + catalog.godot.assets[require('../src/main/installer').platformKey()];
    const good = { tag_name: '9-stable', assets: [{ name: assetName, browser_download_url: 'https://example.org/g.zip', digest: 'sha256:' + 'a'.repeat(64), size: 1 }] };

    const ok = await makeSetup({ fetchImpl: reply(good) }).setup.godotRelease();
    assert.strictEqual(ok.sha256, 'a'.repeat(64));
    assert.strictEqual(ok.tag, '9-stable');

    const noDigest = { ...good, assets: [{ ...good.assets[0], digest: null }] };
    await assert.rejects(makeSetup({ fetchImpl: reply(noDigest) }).setup.godotRelease(), /no checksum/);
    await assert.rejects(makeSetup({ fetchImpl: reply({ tag_name: '9-stable', assets: [] }) }).setup.godotRelease(), /no build for this system/);
    await assert.rejects(makeSetup({ fetchImpl: reply({}, false) }).setup.godotRelease(), /HTTP 404/);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
  process.exitCode = failed ? 1 : 0;
})();
