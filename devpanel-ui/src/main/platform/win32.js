'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('../util');

const name = 'win32';

/**
 * Kill a process AND everything it spawned.
 *
 * Windows has no process groups the way POSIX does: child.kill() only reaches the direct child,
 * so killing a script's shell would leave what it started (kubectl port-forwards, a tunnel)
 * running as orphans. `taskkill /T` walks the whole tree.
 *
 * A hard kill, deliberately: a "graceful" stop would give the script a chance to tear down what
 * it deployed, and the panel only ever means "stop this process", never "undo its work".
 */
function killTree(pid) {
  if (!pid) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  return run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15000 });
}

// Every spelling of "connection established" netstat is known to print. The state column is
// translated on some Windows languages (German prints HERGESTELLT), so the English word alone
// would silently count nothing there.
const ESTABLISHED_WORDS = new Set(['ESTABLISHED', 'HERGESTELLT']);

/**
 * Read `netstat -ano` output for one TCP port: who listens on it, and how many connections are
 * established to it.
 *
 *   TCP    0.0.0.0:8980      0.0.0.0:0          LISTENING       1234
 *   TCP    127.0.0.1:8980    127.0.0.1:51234    ESTABLISHED     1234
 *
 * A listening socket is recognised by its REMOTE address (port 0: there is no peer), never by
 * the state word, which depends on the Windows display language.
 */
function parseNetstat(text, port) {
  const suffix = ':' + port;
  let listenPid = null;
  let established = 0;

  for (const line of String(text || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== 'TCP') continue;
    if (!f[1].endsWith(suffix)) continue;
    if (/:0$/.test(f[2])) {
      if (listenPid == null) listenPid = Number(f[4]);
    } else if (ESTABLISHED_WORDS.has(f[3].toUpperCase())) {
      established += 1;
    }
  }
  return { listenPid, established };
}

/**
 * Who listens on a TCP port, and how many connections are established to it.
 *
 * Shells out to netstat rather than PowerShell's Get-NetTCPConnection on purpose: that cmdlet
 * goes through CIM/WMI, whose quota can be exhausted on a busy machine, and then it throws.
 * netstat is plain Win32 and has no such dependency.
 */
async function portInfo(port) {
  const { stdout } = await run('netstat', ['-ano'], { timeoutMs: 10000 });
  return parseNetstat(stdout, port);
}

/**
 * Reap orphan headless Godot servers.
 *
 * When the editor is closed without stopping the game first, its headless run instance survives
 * and keeps holding the game-server port, so the next server cannot bind it. A headless Godot
 * has no window, hence the MainWindowTitle test.
 *
 * IMPORTANT: the panel's own dedicated server is headless too and matches that test, so every
 * PID the panel owns is excluded -- otherwise this would kill the very server it just started.
 */
async function reapOrphanGodot({ exePath, keepPids = [] }) {
  const exe = path.basename(exePath || '', '.exe');
  if (!exe) return { ok: false, killed: 0, detail: 'no Godot executable configured' };
  // The `_console` build is a wrapper that starts the engine as a child: both names can be alive.
  const names = new Set([exe, exe.replace(/_console$/, ''), exe + '_console']);
  const nameList = [...names].map((n) => "'" + n.replace(/'/g, "''") + "'").join(',');
  const pidList = keepPids.length ? keepPids.map(Number).join(',') : '-1';

  const script =
    '$keep=@(' + pidList + '); ' +
    '$p = Get-Process -Name ' + nameList + ' -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.MainWindowTitle -eq "" -and $keep -notcontains $_.Id }; ' +
    'if ($p) { $p | ForEach-Object { Write-Output ("killed " + $_.Id) }; $p | Stop-Process -Force } ' +
    'else { Write-Output "none" }';

  const r = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs: 20000 }
  );

  const out = r.stdout.trim();
  const killed = out.split(/\n/).filter((l) => l.startsWith('killed')).length;
  return { ok: r.code === 0, killed, detail: out };
}

/** Docker Desktop is a GUI app: launch it detached and wait for the engine separately. */
function startDockerEngine(cfg) {
  const exe = cfg.paths.dockerDesktop;
  if (!exe) {
    return { launched: false, detail: 'start Docker yourself, or set where Docker Desktop is in the settings' };
  }
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    // A missing file surfaces as an 'error' event, not as a throw: without a listener it would
    // take the whole panel down as an unhandled exception.
    child.on('error', () => {});
    child.unref();
    return { launched: true, detail: 'Docker Desktop started' };
  } catch (err) {
    return { launched: false, detail: String(err && err.message) };
  }
}

/**
 * One of the kubernetes repository's own scripts (scripts_windows/<name>.ps1).
 *
 * The panel never reimplements them: they are the documented way to drive the stack, and they
 * move to their repository themselves, so no working directory has to be guessed here.
 */
function repoScriptCommand(cfg, script, args = []) {
  const file = path.join(cfg.paths.kubernetesRepo || '', 'scripts_windows', script + '.ps1');
  return {
    cmd: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args.map(String)],
  };
}

/** start-dev: creates the cluster when there is none, installs ArgoCD, hands it the applications. */
function stackStartCommand(cfg, extraArgs = [], sets = null) {
  const setArgs = sets && sets.length ? ['-Sets', sets.join(',')] : [];
  // The tunnel and the hosts file need an administrator console, which the panel's own network layer
  // replaces: unless the user chose the tunnel mode, start-dev stops once the cluster and ArgoCD are up.
  const tunnelArgs = (cfg.network && cfg.network.mode) === 'tunnel' || extraArgs.includes('-NoTunnel') ? [] : ['-NoTunnel'];
  return repoScriptCommand(cfg, 'start-dev', [...extraArgs, ...tunnelArgs, ...setArgs]);
}

/** clean-dev: deletes the cluster. Not the same thing as stopping the process above. */
function stackStopCommand(cfg) {
  return repoScriptCommand(cfg, 'clean-dev');
}

/**
 * expose-horizon: a port-forward that follows the pod it is attached to and restarts itself
 * when that pod is replaced -- a raw `kubectl port-forward` keeps accepting into a dead pod.
 * It binds every interface, the only way another machine on the LAN can reach the cluster.
 */
function exposeHorizonCommand(cfg) {
  return repoScriptCommand(cfg, 'expose-horizon',
    [cfg.k8s.horizonDeployment || 'horizon', cfg.ports.horizon]);
}

/** build-and-deploy: builds ONE target of dev-projects.yaml inside minikube's docker. */
function buildAndDeployCommand(cfg, target) {
  return repoScriptCommand(cfg, 'build-and-deploy', [target]);
}

/** check-dev: the repository's own prerequisite check. */
function checkDevCommand(cfg) {
  return repoScriptCommand(cfg, 'check-dev');
}

/**
 * Total CPU seconds a process has consumed, or null when it is gone.
 *
 * This is what tells a LIVE server from a WEDGED one, and nothing else does: a frozen Godot
 * server still holds its port, still answers a TCP connect, still shows as Running -- it simply
 * stops burning CPU. Two samples a few seconds apart is the whole test. (Its own log cannot
 * answer: a healthy IDLE server is silent too.)
 */
async function processCpuSeconds(pid) {
  const r = await run('powershell', ['-NoProfile', '-Command',
    '$p = Get-Process -Id ' + Number(pid) + ' -ErrorAction SilentlyContinue;'
    + ' if ($p) { $p.TotalProcessorTime.TotalSeconds } else { "" }'], { timeoutMs: 8000 });
  const out = String(r.stdout || '').trim();
  if (out === '') return null;
  const secs = Number.parseFloat(out.replace(',', '.'));  // some locales print 12,34
  return Number.isFinite(secs) ? secs : null;
}

/**
 * When a process was created, in epoch milliseconds, or null when it is gone.
 *
 * Used to tell a LIVE port-forward from a STALE one, which nothing else can: `kubectl
 * port-forward` resolves its target pod once, at startup, and never follows a replacement. Roll
 * horizon and the tunnel keeps listening, keeps accepting, and delivers into a corpse -- the
 * probe stays green and the client cannot connect. A forward older than the pod it is supposed
 * to reach is necessarily pointing at an earlier one.
 *
 * 'o' is the round-trip format: culture-invariant, so no locale can turn it into something
 * Date.parse reads wrong.
 */
async function processStartTime(pid) {
  const r = await run('powershell', ['-NoProfile', '-Command',
    '$p = Get-Process -Id ' + Number(pid) + ' -ErrorAction SilentlyContinue;'
    + ' if ($p) { $p.StartTime.ToUniversalTime().ToString("o") } else { "" }'], { timeoutMs: 8000 });
  const out = String(r.stdout || '').trim();
  if (out === '') return null;
  const ms = Date.parse(out);
  return Number.isFinite(ms) ? ms : null;
}

module.exports = {
  name,
  killTree,
  portInfo,
  parseNetstat,
  reapOrphanGodot,
  startDockerEngine,
  repoScriptCommand,
  stackStartCommand,
  stackStopCommand,
  exposeHorizonCommand,
  buildAndDeployCommand,
  checkDevCommand,
  processCpuSeconds,
  processStartTime,
};
