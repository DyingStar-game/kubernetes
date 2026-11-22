'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../util');

const name = 'linux';
const PROC = '/proc';

/*
 * Everything here reads /proc directly instead of shelling out to `ss`, `pgrep` or
 * `kill`. Two reasons: no dependency on iproute2 or procps being installed, and it
 * makes the whole layer testable inside a bare container -- which is exactly how the
 * Linux side of this tool was validated from a Windows machine.
 */

/** Numeric entries of /proc are the running processes. */
function pidList() {
  try {
    return fs.readdirSync(PROC).filter((e) => /^\d+$/.test(e)).map(Number);
  } catch {
    return [];
  }
}

function readProc(pid, file) {
  try {
    return fs.readFileSync(path.join(PROC, String(pid), file));
  } catch {
    return null;   // process gone, or not ours: both are normal here
  }
}

/** Parent of a process, from /proc/<pid>/status. */
function parentOf(pid) {
  const buf = readProc(pid, 'status');
  if (!buf) return null;
  const m = buf.toString('utf8').match(/^PPid:\s*(\d+)/m);
  return m ? Number(m[1]) : null;
}

/**
 * Kill a process and every descendant.
 *
 * POSIX has process groups, but relying on them would require spawning detached and
 * would only cover children that stayed in the group. Walking the parent links in
 * /proc reproduces exactly what `taskkill /T` does on Windows, whatever the children
 * did with their groups.
 *
 * SIGKILL, not SIGTERM, on purpose -- same reasoning as the Windows side: a "graceful" stop
 * would give a script the chance to tear down what it deployed, and the panel only ever means
 * "stop this process", never "undo its work".
 */
function killTree(pid) {
  if (!pid) return Promise.resolve({ code: 0, killed: [] });

  const children = new Map();
  for (const p of pidList()) {
    const ppid = parentOf(p);
    if (ppid == null) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(p);
  }

  // Depth-first from the root, deepest killed first so a parent cannot outlive its
  // children long enough to react.
  const ordered = [];
  const seen = new Set();
  const visit = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    for (const c of children.get(p) || []) visit(c);
    ordered.push(p);
  };
  visit(Number(pid));

  const killed = [];
  for (const p of ordered) {
    if (p === process.pid) continue;          // never take the panel down with them
    try {
      process.kill(p, 'SIGKILL');
      killed.push(p);
    } catch { /* already gone */ }
  }
  return Promise.resolve({ code: 0, killed });
}

/*
 * /proc/net/tcp (and tcp6) hold one row per socket:
 *
 *   sl  local_address rem_address st ... inode
 *    0: 00000000:1F90 00000000:0000 0A ... 12345
 *
 * Field 1 is HEXADDR:HEXPORT, field 3 the state (0A listening, 01 established) and
 * field 9 the socket inode -- which is what ties a socket back to a process.
 */
const ST_LISTEN = '0A';
const ST_ESTABLISHED = '01';

function scanTcpTable(file, port) {
  const out = { listenInode: null, established: 0 };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;   // tcp6 is absent on IPv6-less kernels
  }

  const lines = text.split('\n').slice(1);   // drop the header
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const local = f[1].split(':');
    if (local.length < 2) continue;
    if (parseInt(local[local.length - 1], 16) !== port) continue;

    if (f[3] === ST_LISTEN) {
      if (out.listenInode == null) out.listenInode = f[9];
    } else if (f[3] === ST_ESTABLISHED) {
      out.established += 1;
    }
  }
  return out;
}

/** Which process owns a socket inode: the one with a /proc/<pid>/fd/* link to it. */
function pidForInode(inode) {
  const target = 'socket:[' + inode + ']';
  for (const pid of pidList()) {
    let fds;
    try {
      fds = fs.readdirSync(path.join(PROC, String(pid), 'fd'));
    } catch {
      continue;   // EACCES on other users' processes is expected
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(path.join(PROC, String(pid), 'fd', fd)) === target) return pid;
      } catch { /* fd closed under us */ }
    }
  }
  return null;
}

/**
 * Who listens on a port, and how many connections are established to it.
 * Both IPv4 and IPv6 tables are read: a socket bound to "*" lands in tcp6 as a
 * dual-stack listener and would be invisible if only tcp were checked.
 */
async function portInfo(port) {
  const v4 = scanTcpTable(path.join(PROC, 'net', 'tcp'), port);
  const v6 = scanTcpTable(path.join(PROC, 'net', 'tcp6'), port);

  const inode = v4.listenInode != null ? v4.listenInode : v6.listenInode;
  const established = v4.established + v6.established;
  const listenPid = inode != null ? pidForInode(inode) : null;

  return { listenPid, established };
}

/**
 * Reap orphan headless Godot servers holding the game-server port.
 *
 * `--headless` in the command line is the Linux equivalent of the Windows
 * "no window title" test, and a sharper one: it can never match the editor.
 * PIDs the panel owns are excluded -- its own dedicated server is headless too.
 */
async function reapOrphanGodot({ exePath, keepPids = [] }) {
  const base = exePath ? path.basename(exePath).toLowerCase() : '';
  const keep = new Set(keepPids.map(Number));
  const killed = [];

  for (const pid of pidList()) {
    if (pid === process.pid || keep.has(pid)) continue;

    const buf = readProc(pid, 'cmdline');
    if (!buf || !buf.length) continue;
    const argv = buf.toString('utf8').split('\0').filter(Boolean);
    if (!argv.length) continue;

    const exe = path.basename(argv[0]).toLowerCase();
    if (!exe.includes('godot') && exe !== base) continue;
    if (!argv.includes('--headless')) continue;

    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch { /* gone, or not ours */ }
  }

  return {
    ok: true,
    killed: killed.length,
    detail: killed.length ? 'killed ' + killed.join(',') : 'none',
  };
}

/**
 * Bring the Docker daemon up.
 *
 * On Linux the daemon is usually already running as a system service. Docker Desktop
 * for Linux runs as a *user* systemd unit, which we can start without privileges.
 * Starting the plain system daemon needs root, and the panel will never call sudo --
 * it says so instead.
 */
async function startDockerEngine(cfg) {
  const custom = cfg.paths.dockerStartCommand;
  if (custom) {
    const parts = custom.split(/\s+/).filter(Boolean);
    const r = await run(parts[0], parts.slice(1), { timeoutMs: 60000 });
    return {
      launched: r.code === 0,
      detail: r.code === 0 ? custom : (r.stderr || r.stdout || '').trim(),
    };
  }

  const r = await run('systemctl', ['--user', 'start', 'docker-desktop'], { timeoutMs: 60000 });
  if (r.code === 0) return { launched: true, detail: 'docker-desktop (systemd user unit)' };

  return {
    launched: false,
    detail: 'start Docker yourself (sudo systemctl start docker), ' +
      'or set the command that starts it in the settings',
  };
}

/**
 * One of the kubernetes repository's own scripts (scripts_linux/<name>.sh).
 *
 * Run as an argument list, never as a command line pasted into `bash -c`: a path with a quote or
 * a space in it would break a pasted line, and an argument would be read as shell. The scripts
 * move to their repository themselves, so no working directory has to be guessed here.
 */
function repoScriptCommand(cfg, script, args = []) {
  const file = path.join(cfg.paths.kubernetesRepo || '', 'scripts_linux', script + '.sh');
  return { cmd: 'bash', args: [file, ...args.map(String)] };
}

/** start-dev: creates the cluster when there is none, installs ArgoCD, hands it the applications. */
function stackStartCommand(cfg, extraArgs = [], sets = null) {
  const setArgs = sets && sets.length ? ['--sets', sets.join(',')] : [];
  // The tunnel (sudo) and the hosts file are what the panel's own network layer replaces: unless
  // the user chose the tunnel mode, start-dev is told to stop once the cluster and ArgoCD are up.
  const tunnelArgs = (cfg.network && cfg.network.mode) === 'tunnel' || extraArgs.includes('--no-tunnel') ? [] : ['--no-tunnel'];
  return repoScriptCommand(cfg, 'start-dev', [...extraArgs, ...tunnelArgs, ...setArgs]);
}

/** clean-dev: deletes the cluster. Not the same thing as stopping the process above. */
function stackStopCommand(cfg) {
  return repoScriptCommand(cfg, 'clean-dev');
}

/** expose-horizon: a port-forward that follows the pod, unlike a raw `kubectl port-forward`. */
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
 * Total CPU seconds a process has consumed, or null when it is gone. See the win32 twin for WHY:
 * a wedged server is indistinguishable from a healthy one by every other means.
 *
 * utime + stime out of /proc/<pid>/stat, in clock ticks. The comm field can itself contain spaces
 * and parentheses, so the fields are counted from the LAST ')' -- splitting on spaces from the
 * start is the classic way to misread this file.
 */
async function processCpuSeconds(pid) {
  const stat = readProc(pid, 'stat');
  if (!stat) return null;
  const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // stat field 14 is utime; with the first two fields (pid, comm) cut off it lands at index 11.
  const utime = Number.parseInt(tail[11], 10);
  const stime = Number.parseInt(tail[12], 10);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return (utime + stime) / 100;  // USER_HZ is 100 on every Linux we target
}

/**
 * When a process was created, in epoch milliseconds, or null when it is gone.
 *
 * See the win32 twin for why this exists: it is what separates a live port-forward from one still
 * tunnelling into a replaced pod.
 *
 * The kernel sets the ctime of /proc/<pid> when the process is created, so a stat() answers without
 * the boot-time arithmetic that field 22 of /proc/<pid>/stat would need (it counts clock ticks since
 * boot, so it would also need /proc/stat's btime and USER_HZ). Only ordering matters here.
 */
async function processStartTime(pid) {
  try {
    return fs.statSync(path.join(PROC, String(pid))).ctimeMs;
  } catch {
    return null;  // process gone between the port scan and this call
  }
}

module.exports = {
  name,
  killTree,
  portInfo,
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
