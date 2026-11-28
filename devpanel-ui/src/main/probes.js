'use strict';

const { run, tcpProbe, kubeContextName } = require('./util');
const { portInfo, processCpuSeconds, processStartTime } = require('./platform');
const { t } = require('./i18n');

/**
 * Read-only health checks. Nothing here ever starts or stops anything -- the panel
 * polls these on a timer to paint the status lights, and the start chain reuses
 * them as readiness gates.
 */
/// How long between two CPU samples before we dare a verdict. Long enough that a server merely
/// waiting on a slow frame is not called dead.
const ALIVE_WINDOW_S = 5;
/// CPU seconds that must have been consumed over that window to count as alive. An IDLE headless
/// Godot server legitimately burns well under 1% of a core, so this only asks for "not exactly
/// nothing" (one scheduler tick is 0.01 s): a really wedged process gains zero.
const ALIVE_MIN_CPU_S = 0;
/// Consecutive windows without any CPU before calling it frozen: one quiet window is just idle.
const FROZEN_STRIKES = 3;

class Probes {
  /**
   * @param {object} config
   * @param {object} [modules]  { id: bool }, read at each poll: a module that is off is not probed
   */
  constructor(config, modules = null) {
    this.cfg = config;
    this.modules = modules;
    this._cache = new Map();
  }

  _on(id) {
    return !this.modules || this.modules[id] !== false;
  }

  /**
   * Short-lived cache around each probe.
   *
   * Most probes here spawn a process, and process creation is expensive (especially
   * on Windows). Without this, the 5 s status poll and the 2 s relink loop between
   * them ran docker/k3d/kubectl well over a hundred times a minute, which is
   * enough to make the whole panel feel sluggish.
   *
   * It also de-duplicates concurrent callers: the relink watcher and the status poll
   * asking for the TCP table at the same instant share one reading, not two.
   */
  async _cached(key, ttlMs, fn) {
    const hit = this._cache.get(key);
    const now = Date.now();
    if (hit) {
      if (hit.value !== undefined && now - hit.at < ttlMs) return hit.value;
      if (hit.pending) return hit.pending;
    }
    const pending = (async () => {
      const value = await fn();
      this._cache.set(key, { at: Date.now(), value });
      return value;
    })();
    this._cache.set(key, { at: hit ? hit.at : 0, value: hit ? hit.value : undefined, pending });
    return pending;
  }

  /** Force the next read of a probe to hit the real command (after an action changed things). */
  invalidate(key) {
    if (key) this._cache.delete(key); else this._cache.clear();
  }

  /** Is the Docker daemon actually up? (Docker Desktop's window can be open while the engine still boots.) */
  docker() {
    return this._cached('docker', 8000, async () => {
      const r = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 12000 });
      return {
        ok: r.code === 0 && !!r.stdout.trim(),
        detail: r.code === 0 ? t('probe.engine', { version: r.stdout.trim() }) : t('probe.engineDown'),
      };
    });
  }

  /**
   * The k3d cluster: its server node(s) must all be running. `k3d cluster list <name> -o json`
   * gives one object per cluster, with serversRunning / serversCount.
   */
  k3d() {
    return this._cached('k3d', 8000, () => this._k3d());
  }

  async _k3d() {
    const name = (this.cfg.k3d && this.cfg.k3d.cluster) || 'dyingstar';
    const r = await run('k3d', ['cluster', 'list', name, '-o', 'json'], { timeoutMs: 20000 });
    if (r.code !== 0 || !r.stdout.trim()) {
      return { ok: false, detail: t('probe.stopped') };
    }
    try {
      const list = JSON.parse(r.stdout);
      const c = (Array.isArray(list) ? list : [list]).find((x) => x && x.name === name);
      if (!c) return { ok: false, detail: t('probe.stopped') };
      const up = c.serversCount > 0 && c.serversRunning === c.serversCount;
      if (!up) return { ok: false, detail: 'servers ' + c.serversRunning + '/' + c.serversCount };
      // A running server node is not a usable cluster: during `k3d cluster create` the node is up
      // well before the load balancer and the kubeconfig context exist (measured 2026-11-28: the
      // chain went on 10 s too early, with no kube context). The API must answer on this context.
      const api = await run('kubectl', ['--context', 'k3d-' + name, 'get', '--raw', '/version',
        '--request-timeout=5s'], { timeoutMs: 12000 });
      return api.code === 0
        ? { ok: true, detail: 'Running' }
        : { ok: false, detail: 'API not answering yet: ' + ((api.stderr || '').trim().split(/\r?\n/).pop() || 'code ' + api.code) };
    } catch {
      return { ok: false, detail: t('probe.unreadable') };
    }
  }

  /**
   * The repository's scripts refuse to run unless the active kube-context is the k3d one (a guard
   * against ever deploying dev images to a real cluster), so it is a first-class light.
   */
  kubeContext() {
    // Changes only when someone runs `kubectl config use-context`, so it can be stale.
    return this._cached('kubeContext', 15000, async () => {
      const r = await run('kubectl', ['config', 'current-context'], { timeoutMs: 12000 });
      const current = r.stdout.trim();
      const expected = kubeContextName(this.cfg);
      return { ok: current === expected, detail: current || t('probe.none'), expected };
    });
  }

  /** One row per pod, with restart count -- a rising restart count is the tell for a crashloop. */
  pods() {
    return this._cached('pods', 4500, () => this._pods());
  }

  async _pods() {
    const ns = this.cfg.k8s.namespace;
    const r = await run('kubectl', ['get', 'pods', '-n', ns, '-o', 'json'], { timeoutMs: 20000 });
    if (r.code !== 0) return { ok: false, detail: t('probe.kubectlDown'), pods: [] };

    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return { ok: false, detail: t('probe.badAnswer'), pods: [] };
    }

    const pods = (parsed.items || []).map((item) => {
      const statuses = item.status?.containerStatuses || [];
      const ready = statuses.filter((c) => c.ready).length;
      const restarts = statuses.reduce((n, c) => n + (c.restartCount || 0), 0);

      // `phase` says Running even while a container crashloops, so prefer the
      // container-level waiting reason when there is one.
      let phase = item.status?.phase || 'Unknown';
      const waiting = statuses.find((c) => c.state && c.state.waiting);
      if (waiting) phase = waiting.state.waiting.reason || phase;
      if (item.metadata?.deletionTimestamp) phase = 'Terminating';

      return {
        name: item.metadata?.name || '?',
        phase,
        ready: ready + '/' + statuses.length,
        allReady: statuses.length > 0 && ready === statuses.length,
        // A pod that ran to completion (a CloudNativePG initdb or join job, a bootstrap job) is
        // never "ready" and never will be: it is done, not failing. Counting it kept the stack
        // red forever once the services got their CNPG databases (2026-10-08).
        done: item.status?.phase === 'Succeeded',
        restarts,
        startedAt: item.status?.startTime || null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const live = pods.filter((p) => !p.done);
    const allReady = live.length > 0 && live.every((p) => p.allReady);
    return {
      ok: allReady,
      detail: live.length
        ? t('probe.podsReady', { ready: live.filter((p) => p.allReady).length, total: live.length })
        : t('probe.noPod'),
      pods,
    };
  }

  /**
   * Is horizon reachable by the game client?
   *
   * Since the ArgoCD migration the client no longer goes through a kubectl
   * port-forward but through Traefik (horizon.dyingstar.local:80, the hosts entry
   * written by start-dev, served by the ports k3d publishes on localhost). That kills a whole class of
   * false green: a Service follows its endpoints, so it cannot stay pinned to a pod
   * that no longer exists -- which is exactly what cost three sessions.
   *
   * The honest question is therefore no longer "does something accept TCP" but
   * "is there a live horizon behind the door". We answer it with the endpoints,
   * not with a WebSocket upgrade: horizon registers a PLAYER on every upgrade, so
   * probing that way every few seconds would spray phantom players through its log.
   *
   * Both front doors are reported, because both are legitimate: Traefik on 80, and
   * the expose-horizon relay on 7040 (the only one reachable from another machine).
   *
   * Since the client moved to WebTransport (DyingStar#462, kubernetes#51) it reaches horizon
   * through a THIRD door: the UDP NodePort of the horizon Service (30101), which k3d publishes on
   * 127.0.0.1, at https://127.0.0.1:<nodePort> -- Traefik cannot relay QUIC. UDP cannot be probed
   * by a connect, so the door is read off the Service: a UDP port with a nodePort.
   */
  horizonRoute() {
    return this._cached('horizonRoute', 2500, async () => {
      const ns = this.cfg.k8s.namespace;
      const name = this.cfg.k8s.horizonDeployment || 'horizon';
      const host = this.cfg.k8s.horizonHost || 'horizon.dyingstar.local';
      const relayPort = this.cfg.ports.horizon;

      const ep = await run('kubectl', ['get', 'endpoints', name, '-n', ns, '-o', 'json'], { timeoutMs: 12000 });
      let ready = 0;
      if (ep.code === 0) {
        try {
          const j = JSON.parse(ep.stdout);
          ready = (j.subsets || []).reduce((n, s) => n + ((s.addresses || []).length), 0);
        } catch { /* unreadable: treated as zero below, never as success */ }
      }

      // The relay is asked whether something LISTENS on its port, never connected to: it is a
      // port-forward into the horizon pod, so a TCP connect opens a real stream to horizon, which
      // waits for a WebSocket handshake that never comes and logs "Handshake not finished" -- every
      // probe, every 5 s (2026-10-25). Traefik on 80 is connected to as before: without an HTTP
      // request it never reaches horizon.
      const [viaTraefik, relay, wt] = await Promise.all([
        tcpProbe(80, '127.0.0.1'),
        portInfo(relayPort),
        this._webTransportDoor(name, ns),
      ]);
      const viaRelay = relay.listenPid != null;
      const viaWebTransport = wt != null;

      if (ready === 0) {
        return {
          ok: false,
          ready, viaTraefik, viaRelay, viaWebTransport,
          detail: t('probe.hzNoEndpoint'),
        };
      }
      if (!viaTraefik && !viaRelay && !viaWebTransport) {
        return {
          ok: false,
          ready, viaTraefik, viaRelay, viaWebTransport,
          detail: t('probe.hzNoDoor', { port: relayPort }),
        };
      }
      // A door that ACCEPTS is not a door that delivers. _forwardIsStale answers the only
      // question a TCP connect cannot: is this tunnel older than every horizon pod alive, i.e.
      // pinned to one that is gone? Without this call the probe reported OK while the client got
      // ERROR 1337 -- measured on 2026-09-24 with a forward 11 h older than a 3 min old pod.
      const stale = viaRelay ? await this._forwardIsStale(relayPort) : null;
      if (stale) {
        return {
          ok: viaTraefik || viaWebTransport,  // either, if it is up, is still a real way in
          ready, viaTraefik, viaRelay: false, viaWebTransport, stale,
          detail: stale,
        };
      }

      const paths = [];
      if (viaWebTransport) paths.push(wt.url + ' (WebTransport)');
      if (viaTraefik) paths.push('ws://' + host + ':80');
      if (viaRelay) paths.push('ws://127.0.0.1:' + relayPort);
      return {
        ok: true,
        ready, viaTraefik, viaRelay, viaWebTransport, webTransportUrl: wt ? wt.url : null,
        detail: t('probe.hzReady', { n: ready, paths: paths.join(t('probe.or')) }),
      };
    });
  }

  /**
   * The WebTransport door of the horizon Service `name` in `ns`: { url, nodePort } when the
   * Service exposes a UDP port on a nodePort (values-dev webTransport.nodePort), null otherwise. The
   * URL is the one client.ini's horizon_url must hold.
   *
   * k3d publishes that UDP port on the host's loopback (start-dev: -p 30101:30101/udp), on every
   * platform, so the door is always https://127.0.0.1:<nodePort>. If the cluster was created
   * without that mapping the door is not really there: UDP cannot be probed by a connect, so it is
   * checked against what the load balancer container publishes.
   */
  async _webTransportDoor(name, ns) {
    const svc = await run('kubectl', ['get', 'service', name, '-n', ns, '-o', 'json'], { timeoutMs: 12000 });
    if (svc.code !== 0) return null;
    let nodePort = null;
    try {
      for (const p of (JSON.parse(svc.stdout).spec?.ports || [])) {
        if ((p.protocol || 'TCP') === 'UDP' && p.nodePort) nodePort = p.nodePort;
      }
    } catch { return null; }
    if (nodePort == null) return null;
    const lb = 'k3d-' + ((this.cfg.k3d && this.cfg.k3d.cluster) || 'dyingstar') + '-serverlb';
    const ports = await run('docker', ['port', lb], { timeoutMs: 12000 });
    if (ports.code !== 0 || !ports.stdout.includes(nodePort + '/udp')) return null;
    return { url: 'https://127.0.0.1:' + nodePort, nodePort };
  }

  /**
   * Is the thing listening on `port` a port-forward into a pod that no longer exists?
   *
   * A TCP connect is NOT enough to call this port healthy, and believing otherwise has cost three
   * sessions. `kubectl port-forward` resolves its target pod once, at startup, and never follows a
   * replacement. Roll horizon -- a redeploy, a relink, a rebuild of the props image -- and the old
   * tunnel keeps listening and keeps ACCEPTING, then delivers into a corpse. Every light stays green
   * and the client gets ERROR 1337. Measured on 2026-09-10: the port was held by a kubectl from the
   * previous evening while the horizon pod was 87 s old.
   *
   * The verdict compares start times rather than probing, because the honest end-to-end test is a
   * WebSocket upgrade -- and horizon registers a PLAYER on every upgrade, so running one every two
   * seconds would spray phantom players and their disconnect errors through its log. (A plain HTTP
   * GET cannot stand in: horizon answers nothing at all to one, exactly like a dead tunnel.)
   *
   * Compared against the OLDEST surviving horizon pod, not the newest: during a rolling update two
   * pods coexist and a forward into the outgoing one still works. Older than every pod alive means
   * the pod it was created for is gone -- which is the actual failure, stated without false alarms.
   */
  async _forwardIsStale(port) {
    const { listenPid } = await portInfo(port);
    if (listenPid == null) return null;

    const pods = await this.pods();
    if (!pods.ok) return null;  // cluster unreachable: nothing to conclude, stay quiet
    const horizons = (pods.pods || [])
      .filter((p) => /^horizon-/.test(p.name) && p.startedAt)
      .map((p) => Date.parse(p.startedAt))
      .filter(Number.isFinite);
    if (horizons.length === 0) return null;

    const forwardStart = await processStartTime(listenPid);
    if (forwardStart == null) return null;

    const oldestPod = Math.min(...horizons);
    if (forwardStart >= oldestPod) return null;

    const age = Math.round((oldestPod - forwardStart) / 60000);
    return t('probe.staleForward', { port, age });
  }

  /**
   * The local Godot dedicated server (port 8980) and horizon's link to it.
   *
   * `listenPid` identifies the current server process: when it changes, a new server
   * was started and horizon -- which only connects once, at its own startup -- is
   * still bound to the dead one. That PID change is the relink trigger.
   */
  gameServer() {
    // TTL kept just under the relink watcher's 2 s poll, so the watcher always sees
    // fresh data (it must catch a PID change promptly) while the slower status poll
    // reuses that same reading instead of scanning the TCP table again.
    return this._cached('gameServer', 1800, async () => {
      const { listenPid, established } = await portInfo(this.cfg.ports.gameServer);
      const alive = await this._serverAlive(listenPid);
      return {
        ok: listenPid != null,
        alive,
        linked: established >= 1,
        listenPid,
        established,
        detail: listenPid == null
          ? t('probe.noServer')
          : (alive === false
            ? t('probe.serverFrozen', { pid: listenPid })
            : t('probe.serverUp', { pid: listenPid, n: established })),
      };
    });
  }

  /**
   * Is the game server actually RUNNING, or only listening?
   *
   * "Someone listens on 8980" is not "the server is ready" -- and a wedged Godot server is the
   * nastiest case there is, because every other signal still says yes: the port is held, a TCP
   * connect succeeds, the process is Responding, the panel is green, and horizon happily hands it
   * players it will never create. Twice in one day that cost a session.
   *
   * CPU time is the one thing that separates them: a server ticking physics at 60 Hz cannot sit at
   * zero, and a frozen one cannot be anything else. Its own log cannot answer -- a healthy IDLE
   * server is silent too, so silence means both "loaded" and "dead" depending on the question.
   *
   * Returns null while we have no second sample yet: unknown, never a guess. The gates treat null
   * as "let it through" -- refusing an action on a measurement we have not taken would be worse
   * than the problem.
   */
  async _serverAlive(pid) {
    if (pid == null) {
      this._cpuMark = null;
      return null;
    }
    const now = Date.now();
    const cpu = await processCpuSeconds(pid);
    if (cpu == null) {
      this._cpuMark = null;
      return null;
    }
    const mark = this._cpuMark;
    if (!mark || mark.pid !== pid) {
      this._cpuMark = { pid, cpu, at: now };
      return null;  // first sample: nothing to compare against yet
    }
    const elapsed = (now - mark.at) / 1000;
    if (elapsed < ALIVE_WINDOW_S) {
      return mark.alive === undefined ? null : mark.alive;  // keep the last verdict between samples
    }
    // A busy server burns whole seconds; the threshold only has to clear timer noise.
    const burned = (cpu - mark.cpu) > ALIVE_MIN_CPU_S;
    const strikes = burned ? 0 : (mark.strikes || 0) + 1;
    const alive = strikes >= FROZEN_STRIKES ? false : true;
    this._cpuMark = { pid, cpu, at: now, alive, strikes };
    return alive;
  }

  /**
   * Everything at once, for the status bar. A module that is switched off is not probed at all
   * (a panel without the cluster module never starts `k3d cluster list`): its entry says `off`.
   */
  async all() {
    const off = { ok: false, off: true, detail: '' };
    const [docker, k3d, kubeContext, horizonRoute, gameServer] = await Promise.all([
      this._on('docker') ? this.docker() : off,
      this._on('cluster') ? this.k3d() : off,
      this._on('cluster') ? this.kubeContext() : off,
      this._on('horizon') ? this.horizonRoute() : off,
      this._on('gameServer') ? this.gameServer() : off,
    ]);

    // Only ask the cluster for pods when it can actually answer.
    let pods = { ...off, pods: [] };
    if (this._on('cluster')) {
      pods = k3d.ok && kubeContext.ok
        ? await this.pods()
        : { ok: false, detail: t('probe.clusterDown'), pods: [] };
    }

    return { docker, k3d, kubeContext, pods, horizonRoute, gameServer, at: Date.now() };
  }
}

module.exports = { Probes };
