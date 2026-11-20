'use strict';

/*
 * Small pure pieces the rest leans on: masking secrets, the local API's host check, reading
 * netstat, the command lines of the repository's scripts, and where the data lives.
 *
 *   node tools/test-core.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { redactArgs, redactText } = require('../src/main/util');
const { isLoopbackHost } = require('../src/main/api');
const { resolveDataDir, buildPaths, argValue, hasFlag, DATA_DIR_NAME } = require('../src/main/paths');
const win32 = require('../src/main/platform/win32');
const linux = require('../src/main/platform/linux');

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

// A token-shaped string, made up for this test.
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXBsYXllciJ9.c2lnbmF0dXJlLW9mLW5vdGhpbmc';

console.log('\n--- secrets never reach a log ---');

test('a token on a command line is masked, the rest is left alone', () => {
  const out = redactArgs(['--path', '/game', '--token=' + JWT, '--resolution', '1280x720']).join(' ');
  assert.strictEqual(out, '--path /game --token=<redacted> --resolution 1280x720');
});

test('a token given as the next argument is masked too', () => {
  assert.deepStrictEqual(redactArgs(['--token', JWT, '--headless']), ['--token', '<redacted>', '--headless']);
  assert.deepStrictEqual(redactArgs(['--password', 'hunter2']), ['--password', '<redacted>']);
});

test('a token echoed in a line of output is masked', () => {
  const line = redactText('Authorization: Bearer ' + JWT + ' (end)');
  assert.ok(!line.includes(JWT) && line.includes('<redacted token>') && line.endsWith('(end)'));
  assert.strictEqual(redactText('an ordinary line'), 'an ordinary line');
});

console.log('\n--- the local API only answers to this machine ---');

test('loopback names are accepted, anything else is refused', () => {
  for (const ok of ['127.0.0.1', '127.0.0.1:7788', 'localhost:7788', 'LOCALHOST', '[::1]:7788']) {
    assert.strictEqual(isLoopbackHost(ok), true, ok);
  }
  for (const bad of ['evil.example:7788', '192.168.1.10:7788', '', undefined, '127.0.0.1.evil.example']) {
    assert.strictEqual(isLoopbackHost(bad), false, String(bad));
  }
});

console.log('\n--- reading netstat (Windows) ---');

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:8980           0.0.0.0:0              LISTENING       4242',
  '  TCP    127.0.0.1:8980         127.0.0.1:51234        ESTABLISHED     4242',
  '  TCP    127.0.0.1:8980         127.0.0.1:51235        TIME_WAIT       0',
  '  TCP    127.0.0.1:18980        127.0.0.1:51236        ESTABLISHED     7',
  '  TCP    [::]:7040              [::]:0                 ABHOEREN        99',
  '  TCP    [::1]:7040             [::1]:51237            HERGESTELLT     99',
  '  UDP    0.0.0.0:8980           *:*                                    5',
].join('\r\n');

test('the listener and the established links of one port', () => {
  assert.deepStrictEqual(win32.parseNetstat(NETSTAT, 8980), { listenPid: 4242, established: 1 });
});

test('a port is matched whole (8980 is not 18980)', () => {
  assert.deepStrictEqual(win32.parseNetstat(NETSTAT, 18980), { listenPid: null, established: 1 });
});

test('a translated state column still gives the listener (and the known translation the links)', () => {
  assert.deepStrictEqual(win32.parseNetstat(NETSTAT, 7040), { listenPid: 99, established: 1 });
});

test('a free port, an empty output', () => {
  assert.deepStrictEqual(win32.parseNetstat(NETSTAT, 1234), { listenPid: null, established: 0 });
  assert.deepStrictEqual(win32.parseNetstat('', 8980), { listenPid: null, established: 0 });
});

console.log('\n--- the repository\'s scripts ---');

const cfg = {
  paths: { kubernetesRepo: path.join('ws', "it's a repo", 'kubernetes') },
  k8s: { horizonDeployment: 'horizon' },
  ports: { horizon: 7040 },
};

test('Linux: an argument list, never a pasted command line', () => {
  const start = linux.stackStartCommand(cfg, ['--no-tunnel']);
  assert.strictEqual(start.cmd, 'bash');
  assert.deepStrictEqual(start.args,
    [path.join(cfg.paths.kubernetesRepo, 'scripts_linux', 'start-dev.sh'), '--no-tunnel']);
  // The quote and the space in the path are just characters of one argument.
  assert.ok(!start.args.includes('-c') && !start.args.includes('-lc'));

  assert.deepStrictEqual(linux.exposeHorizonCommand(cfg).args.slice(1), ['horizon', '7040']);
  assert.deepStrictEqual(linux.buildAndDeployCommand(cfg, 'horizon-data').args.slice(1), ['horizon-data']);
  assert.ok(linux.stackStopCommand(cfg).args[0].endsWith('clean-dev.sh'));
  assert.ok(linux.checkDevCommand(cfg).args[0].endsWith('check-dev.sh'));
});

test('Windows: the same scripts, through PowerShell -File', () => {
  const start = win32.stackStartCommand(cfg);
  assert.strictEqual(start.cmd, 'powershell');
  const at = start.args.indexOf('-File');
  assert.ok(at >= 0);
  assert.strictEqual(start.args[at + 1], path.join(cfg.paths.kubernetesRepo, 'scripts_windows', 'start-dev.ps1'));
  assert.deepStrictEqual(win32.exposeHorizonCommand(cfg).args.slice(-2), ['horizon', '7040']);
  assert.deepStrictEqual(win32.buildAndDeployCommand(cfg, 'economie').args.slice(-1), ['economie']);
});

test('both platform layers offer the same operations', () => {
  const names = (m) => Object.keys(m).filter((k) => typeof m[k] === 'function' && k !== 'parseNetstat').sort();
  assert.deepStrictEqual(names(linux), names(win32));
});

console.log('\n--- where the data lives ---');

test('the data directory: flag first, then the environment, then the per-user folder', () => {
  const appDataDir = path.join('appdata');
  assert.deepStrictEqual(resolveDataDir({ argv: [], env: {}, appDataDir }),
    { dataDir: path.join(appDataDir, DATA_DIR_NAME), overridden: false });
  assert.strictEqual(resolveDataDir({ argv: [], env: { DS_DEVPANEL_DATA_DIR: 'envdir' }, appDataDir }).dataDir,
    path.resolve('envdir'));
  const flag = resolveDataDir({ argv: ['--data-dir=flagdir'], env: { DS_DEVPANEL_DATA_DIR: 'envdir' }, appDataDir });
  assert.deepStrictEqual(flag, { dataDir: path.resolve('flagdir'), overridden: true });
});

test('nothing the panel writes is next to its code', () => {
  const p = buildPaths({ appRoot: path.join('app'), dataDir: path.join('data') });
  for (const key of ['configFile', 'logDir', 'runtimeDir', 'profilesDir']) {
    assert.ok(p[key].startsWith('data'), key + ' = ' + p[key]);
  }
});

test('command-line flags', () => {
  assert.strictEqual(argValue(['--screenshot=a.png'], 'screenshot'), 'a.png');
  assert.strictEqual(argValue(['--screenshot', 'a.png'], 'screenshot'), 'a.png');
  assert.strictEqual(argValue(['--screenshot', '--other'], 'screenshot'), null);
  assert.strictEqual(hasFlag(['--smoke-test'], 'smoke-test'), true);
  assert.strictEqual(hasFlag(['--smoke-tests'], 'smoke-test'), false);
});

console.log('\n--- an installed panel gets a usable environment ---');

const { mergePath, stripAppImage, fixEnvironment } = require('../src/main/env');

test('the login shell\'s PATH is added after what is there, without duplicates', () => {
  assert.strictEqual(mergePath('/usr/bin:/bin', '/home/dev/.local/bin:/usr/bin', ':'),
    '/usr/bin:/bin:/home/dev/.local/bin');
  assert.strictEqual(mergePath('', '/a:/b', ':'), '/a:/b');
  assert.strictEqual(mergePath('/a', null, ':'), '/a');
});

test('children do not inherit what points inside the AppImage', () => {
  const env = {
    APPIMAGE: '/opt/panel.AppImage', APPDIR: '/tmp/.mount_abc', ARGV0: 'panel',
    LD_LIBRARY_PATH: '/tmp/.mount_abc/usr/lib:/usr/lib', PATH: '/tmp/.mount_abc/bin:/usr/bin',
    XDG_DATA_DIRS: '/tmp/.mount_abc/share', HOME: '/home/dev',
  };
  assert.strictEqual(stripAppImage(env, ':'), '/opt/panel.AppImage', 'the image path is returned, to relaunch');
  assert.deepStrictEqual(env, {
    APPIMAGE: '/opt/panel.AppImage', LD_LIBRARY_PATH: '/usr/lib', PATH: '/usr/bin', HOME: '/home/dev',
  });
});

test('outside an AppImage, and on Windows, nothing is touched', () => {
  const env = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/usr/lib' };
  assert.strictEqual(stripAppImage(env, ':'), null);
  assert.deepStrictEqual(env, { PATH: '/usr/bin', LD_LIBRARY_PATH: '/usr/lib' });
  const win = { Path: 'C:\\Windows' };
  assert.deepStrictEqual(fixEnvironment({ packaged: true, env: win, platform: 'win32' }),
    { appImage: null, pathFromShell: false });
  assert.deepStrictEqual(win, { Path: 'C:\\Windows' });
});

console.log('\n--- nothing personal in what is published ---');

/** Every text file that ships: the code, the tools, the docs. */
function shippedFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', '.git', 'logs', '.runtime', 'dist'].includes(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) shippedFiles(full, out);
    else if (/\.(js|json|html|css|md|yaml|yml|ps1|sh)$/i.test(name) && name !== 'package-lock.json'
      && name !== 'config.json') out.push(full);
  }
  return out;
}

test('no absolute path of somebody\'s machine in the sources', () => {
  // Drive letters other than the system one, and home folders: a path like that can only have
  // come from one person's disk. (Made-up paths in tests use /fake, X:\ or a temp folder.)
  const root = path.join(__dirname, '..');
  const suspects = [
    /\b[A-BD-WYZ]:\\{1,2}[A-Za-z]/,                 // D:\..., H:\... (C: is the system, X: is for examples)
    /\/home\/(?!you\b|dev\b|user\b)[a-z0-9_-]+\//i,
    /C:\\{1,2}Users\\{1,2}(?!you\b|Public\b)[A-Za-z0-9_-]+/i,
  ];
  const hits = [];
  for (const file of shippedFiles(root)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (suspects.some((re) => re.test(line))) hits.push(path.relative(root, file) + ':' + (i + 1));
    });
  }
  assert.deepStrictEqual(hits, []);
});

console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
