'use strict';

const { run } = require('./util');
const { t } = require('./i18n');

/**
 * Telepresence, as the kubernetes repository's README uses it: the documented way to run the
 * game server from your sources.
 *
 *   connect     gives this machine the cluster's DNS and routes, so a local process reaches the
 *               in-cluster services by name, exactly like a pod;
 *   intercept   sends the traffic meant for the cluster's game server to the local one.
 *
 * Nothing here is reimplemented: each button runs the `telepresence` command a developer would
 * type, as a tracked process whose output lands in the "telepresence" log tab.
 *
 * Two things the README insists on, and that the panel enforces elsewhere:
 *   - the client must match the traffic manager ArgoCD installed (same major.minor): the status
 *     light says so when it does not;
 *   - minikube must never be (re)started while connected: the start chain quits Telepresence
 *     first (see Services.startMinikube).
 */
const WORKLOAD = 'godotserver';

/** "v2.28.0" / "2.28.0" -> "2.28"; '' when unreadable. */
function minorOf(version) {
  const m = String(version || '').match(/(\d+)\.(\d+)/);
  return m ? m[1] + '.' + m[2] : '';
}

/**
 * Read `telepresence status --output json`.
 * Returns { installed, connected, namespace, context, clientVersion, managerVersion, mismatch }.
 */
function parseStatus(stdout) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  const user = doc.user_daemon || {};
  const manager = doc.traffic_manager || {};
  const connected = user.running === true && user.status === 'Connected';
  const clientVersion = String(user.version || (doc.root_daemon || {}).version || '');
  const managerVersion = String(manager.version || '');
  return {
    installed: true,
    connected,
    namespace: user.namespace || '',
    context: user.kubernetes_context || '',
    clientVersion,
    managerVersion,
    mismatch: connected && !!minorOf(clientVersion) && !!minorOf(managerVersion)
      && minorOf(clientVersion) !== minorOf(managerVersion),
  };
}

/**
 * Does `telepresence list` say this workload is intercepted?
 *
 *   deployment godotserver                 : intercepted
 *   deployment horizon                     : ready to engage (traffic-agent not yet installed)
 */
function isIntercepted(listOutput, workload) {
  return String(listOutput || '').split(/\r?\n/).some((line) => {
    const m = line.match(/^\s*\S+\s+(\S+)\s*:\s*(.+)$/);
    return !!m && m[1] === workload && /^intercepted\b/.test(m[2].trim());
  });
}

/**
 * May `telepresence list` be run? Only on a session that exists, at our namespace: without one,
 * `list` CONNECTS by itself to the namespace of the kubeconfig (`default`), and the
 * `connect --namespace` that follows is refused ("Cluster configuration changed").
 */
function mayList(status, namespace) {
  return !!status && status.connected === true && status.namespace === namespace;
}

class Telepresence {
  constructor({ config, log, procs }) {
    this.cfg = config;
    this.log = log;
    this.procs = procs;
  }

  /** For the status light. Never starts anything: `status` only asks the daemons, if any. */
  async probe() {
    const r = await run('telepresence', ['status', '--output', 'json'], { timeoutMs: 8000 });
    if (r.code !== 0 && !r.stdout.trim()) {
      return { ok: false, installed: false, connected: false, detail: t('tp.notInstalled') };
    }
    const status = parseStatus(r.stdout);
    if (!status) return { ok: false, installed: true, connected: false, detail: t('tp.unreadable') };

    let detail = t('tp.disconnected');
    if (status.connected) {
      detail = status.mismatch
        ? t('tp.mismatch', { client: status.clientVersion, manager: status.managerVersion })
        : t('tp.connected', { namespace: status.namespace, version: status.clientVersion });
    }
    // Connected to another namespace is not "ok" for us: the names would resolve elsewhere.
    const rightPlace = status.namespace === this.cfg.k8s.namespace;
    const intercepted = status.connected ? await this.intercepted() : false;
    return {
      ...status, intercepted, ok: status.connected && rightPlace && !status.mismatch, warn: status.mismatch, detail,
    };
  }

  /**
   * Is the cluster's game server currently intercepted? Read from `telepresence list`.
   *
   * `status` is asked first, which never starts anything: see mayList.
   */
  async intercepted() {
    const s = await run('telepresence', ['status', '--output', 'json'], { timeoutMs: 8000 });
    if (!mayList(parseStatus(s.stdout), this.cfg.k8s.namespace)) return false;
    const r = await run('telepresence', ['list'], { timeoutMs: 10000 });
    return r.code === 0 && isIntercepted(r.stdout, WORKLOAD);
  }

  /**
   * Connect to the cluster.
   *
   * The command is run as it is, WITHOUT elevation. Only Telepresence's network daemon needs
   * elevated rights, and Telepresence asks for them itself (the system's prompt on Windows).
   * Elevating the whole command is a trap: the session then lives in the administrator's context,
   * where an unelevated `telepresence status` -- and so this panel -- cannot see it.
   *
   * Elsewhere than on Windows it asks for the sudo password on a terminal the panel does not
   * have, so the log says to run it once from a terminal.
   */
  connect() {
    const args = ['connect', '--namespace', this.cfg.k8s.namespace];
    if (process.platform !== 'win32') {
      this.log.note('Telepresence needs the sudo password to start its network daemon: if this fails, run '
        + '"telepresence connect --namespace ' + this.cfg.k8s.namespace + '" once from a terminal.', 'WARN');
    }
    return this._start('telepresence connect', args);
  }

  /** Send the traffic meant for the cluster's game server to the local one. */
  intercept() {
    // No volume mounts: they need extra system components and the game server does not use them.
    return this._start('telepresence intercept',
      ['intercept', WORKLOAD, '--port', String(this.cfg.ports.gameServer), '--mount=false']);
  }

  /** Stop the intercept; the connection stays. */
  leave() {
    return this._start('telepresence leave', ['leave', WORKLOAD]);
  }

  /** End the session and stop the daemons. */
  quit() {
    return this._start('telepresence quit', ['quit', '-s']);
  }

  _start(label, args) {
    return this.procs.start({ id: 'telepresence', label, source: 'telepresence', cmd: 'telepresence', args });
  }
}

module.exports = { Telepresence, parseStatus, isIntercepted, mayList, minorOf, WORKLOAD };
