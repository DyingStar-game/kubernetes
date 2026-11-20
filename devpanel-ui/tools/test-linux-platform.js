'use strict';

/**
 * Tests for the Linux platform layer (src/main/platform/linux.js).
 *
 * These cover the three operations that genuinely differ from Windows and that would
 * silently break the panel if wrong: killing a process tree, finding who listens on a
 * TCP port, and reaping orphan headless Godot servers.
 *
 * Plain Node, no Electron and no test framework, so it runs anywhere:
 *
 *   node tools/test-linux-platform.js
 *
 * or, from a Windows machine, inside a container:
 *
 *   docker run --rm -v <path to>/devpanel-ui:/app -w /app node:22-alpine \
 *       node tools/test-linux-platform.js
 */

const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const platform = require('../src/main/platform');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

async function test(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  OK   ' + title);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + title);
    console.log('        ' + (err && err.message));
  }
}

/** Alive AND not a zombie: a killed grandchild lingers as Z until something reaps it. */
function isRunning(pid) {
  let stat;
  try {
    stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  } catch {
    return false;
  }
  // "pid (comm) STATE ..." -- comm can contain spaces, so read after the last ')'.
  const after = stat.slice(stat.lastIndexOf(')') + 2);
  return after[0] !== 'Z';
}

function childrenOf(pid) {
  const out = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const status = fs.readFileSync('/proc/' + e + '/status', 'utf8');
      const m = status.match(/^PPid:\s*(\d+)/m);
      if (m && Number(m[1]) === pid) out.push(Number(e));
    } catch { /* vanished */ }
  }
  return out;
}

(async () => {
  console.log('Platform layer: ' + platform.name + ' (process.platform=' + process.platform + ')');
  if (process.platform !== 'linux') {
    console.log('These tests only apply to Linux: skipped.');
    process.exit(2);
  }
  console.log('');

  // --- 1. killTree ---------------------------------------------------------
  await test('killTree tue aussi les petits-enfants', async () => {
    const parent = spawn('sh', ['-c', 'sleep 120 & sleep 120 & sleep 120 & wait'], { stdio: 'ignore' });
    await sleep(600);

    const kids = childrenOf(parent.pid);
    assert.ok(kids.length >= 3, 'attendu >=3 enfants, vu ' + kids.length);

    await platform.killTree(parent.pid);
    await sleep(400);

    const survivors = kids.filter(isRunning);
    assert.strictEqual(survivors.length, 0, 'petits-enfants survivants : ' + survivors.join(','));
    assert.ok(!isRunning(parent.pid), 'le parent survit');
  });

  await test('killTree sur un PID inexistant ne jette pas', async () => {
    const r = await platform.killTree(999999);
    assert.ok(r && Array.isArray(r.killed));
  });

  // --- 2. portInfo ---------------------------------------------------------
  const PORT = 18980;
  const server = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => server.listen(PORT, '0.0.0.0', r));

  await test('portInfo trouve le PID qui ecoute', async () => {
    const info = await platform.portInfo(PORT);
    assert.strictEqual(info.listenPid, process.pid,
      'listenPid=' + info.listenPid + ' attendu ' + process.pid);
    assert.strictEqual(info.established, 0, 'established=' + info.established + ' attendu 0');
  });

  const client = net.connect(PORT, '127.0.0.1');
  await new Promise((r, j) => { client.once('connect', r); client.once('error', j); });

  await test('portInfo compte les connexions etablies', async () => {
    const info = await platform.portInfo(PORT);
    assert.strictEqual(info.established, 1, 'established=' + info.established + ' attendu 1');
  });

  await test('portInfo ignore un port libre', async () => {
    const info = await platform.portInfo(PORT + 1);
    assert.strictEqual(info.listenPid, null);
    assert.strictEqual(info.established, 0);
  });

  client.destroy();
  await new Promise((r) => server.close(r));

  await test('portInfo ne voit plus rien apres fermeture', async () => {
    const info = await platform.portInfo(PORT);
    assert.strictEqual(info.listenPid, null, 'listenPid=' + info.listenPid);
  });

  // --- 3. reapOrphanGodot --------------------------------------------------
  //
  // A believable stand-in for Godot needs argv[0] to look like the binary AND
  // --headless to appear in the command line. A shell script will not do: the kernel
  // rewrites argv[0] to the interpreter. A symlink to a real native binary keeps
  // argv[0] intact, which is exactly how the real godot process looks.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'godotfake-'));
  const fakeExe = path.join(tmp, 'Godot_v4.7-stable_mono_linux_x86_64');
  fs.symlinkSync(process.execPath, fakeExe);

  // The idle body goes in a FILE, not in `-e`: node parses a bare `--headless` as one
  // of its own options and exits, whereas everything after a script path is handed to
  // the script untouched -- and lands in /proc/<pid>/cmdline, which is what we test.
  const keepAlive = path.join(tmp, 'keepalive.js');
  fs.writeFileSync(keepAlive, 'setInterval(() => {}, 1000);\n');

  const orphan = spawn(fakeExe, [keepAlive, '--headless'], { stdio: 'ignore' });
  const editor = spawn(fakeExe, [keepAlive], { stdio: 'ignore' });            // no --headless
  const ours = spawn(fakeExe, [keepAlive, '--headless'], { stdio: 'ignore' }); // panel-owned
  await sleep(900);

  await test('les faux Godot tournent bien (garde-fou du test)', async () => {
    assert.ok(isRunning(orphan.pid), 'orphelin deja mort');
    assert.ok(isRunning(editor.pid), 'editeur deja mort');
    assert.ok(isRunning(ours.pid), 'serveur du panneau deja mort');
  });

  await test('reapOrphanGodot tue le serveur headless orphelin', async () => {
    const r = await platform.reapOrphanGodot({ exePath: fakeExe, keepPids: [ours.pid] });
    await sleep(400);
    assert.ok(r.killed >= 1, 'aucun tue (detail: ' + r.detail + ')');
    assert.ok(!isRunning(orphan.pid), 'l orphelin survit');
  });

  await test('reapOrphanGodot epargne l editeur (pas de --headless)', async () => {
    assert.ok(isRunning(editor.pid), 'l editeur a ete tue a tort');
  });

  await test('reapOrphanGodot epargne les PID du panneau', async () => {
    assert.ok(isRunning(ours.pid), 'le serveur du panneau a ete tue a tort');
  });

  await test('reapOrphanGodot ne tue rien quand il n y a rien', async () => {
    await platform.killTree(editor.pid);
    await platform.killTree(ours.pid);
    await sleep(400);
    const r = await platform.reapOrphanGodot({ exePath: fakeExe, keepPids: [] });
    assert.strictEqual(r.killed, 0, 'a tue ' + r.detail);
  });

  // --- 4. the repository's scripts -----------------------------------------
  await test('the start script is run by argument list, not through a shell string', async () => {
    const { cmd, args } = platform.stackStartCommand(
      { paths: { kubernetesRepo: '/home/dev/ws/kubernetes' }, k8s: {}, ports: {} },
      ['--no-tunnel']
    );
    assert.strictEqual(cmd, 'bash');
    assert.deepStrictEqual(args, ['/home/dev/ws/kubernetes/scripts_linux/start-dev.sh', '--no-tunnel']);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('');
  console.log('Result: ' + passed + ' passed, ' + failed + ' failed.');
  process.exit(failed ? 1 : 0);
})();
