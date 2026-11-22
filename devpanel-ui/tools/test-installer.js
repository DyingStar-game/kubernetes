'use strict';

/*
 * Fetching tools: the checksum is the gate, versions are judged the way the scripts need.
 * Offline: the downloads come from a server started here, on 127.0.0.1.
 *
 *   node tools/test-installer.js
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  Toolchain, platformKey, parseVersion, compareVersions, versionVerdict, sha256Of, downloadVerified,
} = require('../src/main/installer');
const toolchain = require('../src/main/toolchain.json');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpanel-installer-'));
const PAYLOAD = Buffer.from('#!/bin/sh\necho "not a real tool"\n'.repeat(500));
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/tool') {
      res.writeHead(200, { 'content-length': PAYLOAD.length });
      res.end(PAYLOAD);
    } else if (req.url === '/moved') {
      res.writeHead(302, { location: '/tool' });
      res.end();
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  console.log('\n--- a download is only kept when its checksum matches ---');

  await test('the right checksum: the file is there, complete, with no leftover', async () => {
    const dest = path.join(tmp, 'a', 'tool');
    let seen = 0;
    const r = await downloadVerified({ url: base + '/tool', dest, sha256: PAYLOAD_SHA, onProgress: (n) => { seen = n; } });
    assert.strictEqual(r.bytes, PAYLOAD.length);
    assert.strictEqual(seen, PAYLOAD.length, 'progress reaches the end');
    assert.strictEqual(await sha256Of(dest), PAYLOAD_SHA);
    assert.strictEqual(fs.existsSync(dest + '.part'), false);
  });

  await test('a redirect is followed (release downloads are redirected)', async () => {
    const dest = path.join(tmp, 'b', 'tool');
    await downloadVerified({ url: base + '/moved', dest, sha256: PAYLOAD_SHA });
    assert.strictEqual(await sha256Of(dest), PAYLOAD_SHA);
  });

  await test('the wrong checksum: nothing is kept, and the error says so', async () => {
    const dest = path.join(tmp, 'c', 'tool');
    await assert.rejects(
      downloadVerified({ url: base + '/tool', dest, sha256: 'f'.repeat(64) }),
      /checksum mismatch/);
    assert.strictEqual(fs.existsSync(dest), false);
    assert.strictEqual(fs.existsSync(dest + '.part'), false);
  });

  await test('a failed download does not replace a file that was already good', async () => {
    const dest = path.join(tmp, 'a', 'tool');
    await assert.rejects(downloadVerified({ url: base + '/missing', dest, sha256: PAYLOAD_SHA }), /HTTP 404/);
    assert.strictEqual(await sha256Of(dest), PAYLOAD_SHA);
  });

  await test('no checksum, or an address that is not https: refused before anything is fetched', async () => {
    await assert.rejects(downloadVerified({ url: base + '/tool', dest: path.join(tmp, 'd'), sha256: '' }), /SHA-256/);
    await assert.rejects(
      downloadVerified({ url: 'http://example.org/tool', dest: path.join(tmp, 'd'), sha256: PAYLOAD_SHA }),
      /non-https/);
  });

  // Close what is still open rather than cutting the process: exiting while connections are being
  // torn down trips an assertion in the runtime on Windows.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));

  console.log('\n--- versions ---');

  await test('versions are read and compared as numbers', () => {
    assert.deepStrictEqual(parseVersion('v3.21.0+ge0878d4'), [3, 21, 0]);
    assert.deepStrictEqual(parseVersion('Client Version: v1.34.1'), [1, 34, 1]);
    assert.strictEqual(parseVersion('command not found'), null);
    assert.ok(compareVersions([1, 9, 0], [1, 10, 0]) < 0, '1.9 is older than 1.10');
    assert.strictEqual(compareVersions([3, 21, 0], [3, 21, 0]), 0);
  });

  await test('too old is refused; Helm 3 and 4 are accepted, a later major is not', () => {
    const helm = toolchain.tools.find((t) => t.id === 'helm');
    assert.strictEqual(versionVerdict(helm, 'v3.21.0').ok, true);
    assert.strictEqual(versionVerdict(helm, 'v4.3.0').ok, true);
    assert.deepStrictEqual(versionVerdict(helm, 'v3.9.4'), { ok: false, reason: 'too-old', version: '3.9.4' });
    assert.deepStrictEqual(versionVerdict(helm, 'v5.0.0'), { ok: false, reason: 'too-new', version: '5.0.0' });
    const kubectl = toolchain.tools.find((t) => t.id === 'kubectl');
    assert.strictEqual(versionVerdict(kubectl, 'v1.40.0').ok, true, 'a newer kubectl is fine');
  });

  console.log('\n--- the list of tools ---');

  await test('every tool has, for Windows and Linux, an https address and a full SHA-256', () => {
    assert.ok(toolchain.tools.length >= 3);
    for (const tool of toolchain.tools) {
      assert.ok(parseVersion(tool.version) && parseVersion(tool.minVersion), tool.id + ': versions');
      assert.ok(compareVersions(parseVersion(tool.version), parseVersion(tool.minVersion)) >= 0, tool.id);
      assert.ok(new RegExp(tool.versionPattern), tool.id + ': pattern');
      for (const key of ['win32-x64', 'linux-x64']) {
        const asset = tool.assets[key];
        assert.ok(asset, tool.id + ' has no ' + key);
        assert.ok(/^https:\/\//.test(asset.url), tool.id + ' ' + key + ': https');
        assert.ok(/^[0-9a-f]{64}$/.test(asset.sha256), tool.id + ' ' + key + ': sha256');
        assert.ok(asset.url.includes(tool.version), tool.id + ' ' + key + ': the address is not for version ' + tool.version);
        if (asset.archive) assert.ok(asset.member && asset.member.endsWith(asset.file), tool.id + ' ' + key + ': member');
        assert.strictEqual(/\.exe$/.test(asset.file), key.startsWith('win32'), tool.id + ' ' + key + ': file name');
      }
    }
  });

  await test('the two systems are told apart, and the panel\'s folder goes first on the PATH', () => {
    assert.strictEqual(platformKey('win32', 'x64'), 'win32-x64');
    assert.strictEqual(platformKey('darwin', 'arm64'), 'linux-arm64');
    const tc = new Toolchain({ toolsDir: path.join(tmp, 'tools'), log: { note() {} }, platform: 'linux' });
    const env = { PATH: ['/usr/bin', tc.binDir, '/bin'].join(path.delimiter) };
    tc.prependToPath(env);
    assert.deepStrictEqual(env.PATH.split(path.delimiter), [tc.binDir, '/usr/bin', '/bin'], 'first, and only once');
  });

  await test('a system with no published binary is told so, not sent a wrong file', async () => {
    const tc = new Toolchain({ toolsDir: path.join(tmp, 'tools'), log: { note() {} }, platform: 'linux', arch: 'riscv64' });
    await assert.rejects(tc.install('helm'), /cannot be fetched automatically/);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
  process.exitCode = failed ? 1 : 0;
})();
