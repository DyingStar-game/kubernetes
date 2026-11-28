'use strict';

const { EventEmitter } = require('node:events');
const { run, waitFor, sleep } = require('./util');
const platform = require('./platform');
const { t } = require('./i18n');

/**
 * The start chain.
 *
 * Each step has a readiness gate that tests the thing that actually matters, not
 * "did the command return". That distinction is the whole point: `k3d cluster start`
 * exiting does not mean the API server answers, and Docker Desktop's window opening
 * does not mean the engine accepts connections.
 *
 * Order is not cosmetic. The local Godot server must be listening on 8980 BEFORE
 * horizon is restarted, because horizon connects exactly once at startup. Get that
 * backwards and the player spawns but cannot move.
 */
// Each step belongs to a module: a module that is switched off takes its steps out of the chain.
// A step's name is the translation of "step.<id>"; what a step SAYS (its message) is shown on
// screen, so it goes through t() too. What goes to the log does not.
const STEPS = [
  { id: 'docker', module: 'docker' },
  { id: 'k3d', module: 'cluster' },
  { id: 'context', module: 'cluster' },
  { id: 'stack', module: 'cluster' },
  { id: 'network', module: 'network' },
  { id: 'telepresence', module: 'telepresence' },
  { id: 'godot-server', module: 'gameServer' },
  // Intercepting only means something with a local server to send the traffic to.
  { id: 'intercept', module: 'telepresence', also: 'gameServer' },
  { id: 'relink', module: 'relink' },
];

class Services extends EventEmitter {
  constructor({ config, log, procs, probes, godot, relink, telepresence = null, network = null, modules = null, wantedSets = () => null }) {
    super();
    this.wantedSets = wantedSets;
    this.cfg = config;
    this.telepresence = telepresence;
    this.network = network;
    this.modules = modules;   // { id: bool }, read at each use
    this.log = log;
    this.procs = procs;
    this.probes = probes;
    this.godot = godot;
    this.relink = relink;

    this.chain = {
      running: false,
      aborted: false,
      steps: STEPS.map((s) => ({ ...s, state: 'idle', message: '' })),
    };
    this._abort = null;
  }

  _on(id) {
    return !this.modules || this.modules[id] !== false;
  }

  chainState() {
    return {
      running: this.chain.running,
      steps: this.chain.steps
        .filter((s) => this._on(s.module) && (!s.also || this._on(s.also)))
        .map((s) => ({ id: s.id, label: t('step.' + s.id), state: s.state, message: s.message })),
    };
  }

  /**
   * Reconcile the startup steps with what the probes actually see.
   *
   * The chain's steps used to be a pure record of the last "start everything" run, and nothing
   * ever cleared them: a step that failed once stayed red for the rest of the day, even after the
   * thing it describes had been started by hand. Sitting next to genuinely live indicators, it read
   * as one -- and sent us hunting a server that was running perfectly well.
   *
   * The same mistake in reverse hurts just as much: reopening the panel showed Docker, k3d,
   * the context and the k8s stack all grey, as if nothing were up, while twelve pods were serving
   * happily. A step is only worth reading if it says what IS, so every one of them is now derived
   * from a probe rather than from what the panel happens to remember doing.
   *
   * Never touches a chain that is running -- the chain owns its steps while it works.
   */
  syncStepsWithProbes(probes) {
    if (this.chain.running || !probes) return;

    const ok = (probe) => probe && probe.ok === true;
    const detail = (probe, fallback) => (probe && probe.detail) || fallback;

    this._set('docker', ok(probes.docker) ? 'ok' : 'idle',
      detail(probes.docker, t('msg.dockerDown')));
    this._set('k3d', ok(probes.k3d) ? 'ok' : 'idle',
      detail(probes.k3d, t('msg.clusterStopped')));
    this._set('context', ok(probes.kubeContext) ? 'ok' : 'idle',
      detail(probes.kubeContext, t('msg.wrongContext')));

    // The k8s stack is judged on its RESULT (pods ready and horizon reachable), not on whether the
    // panel owns the start-dev process: it may well have been started elsewhere, and ArgoCD keeps
    // the deployment up long after the panel is closed -- the stack is up either way.
    const podsOk = ok(probes.pods);
    const portOk = ok(probes.horizonRoute) || !this._on('horizon');
    const port = this.cfg.ports.horizon;
    if (podsOk && portOk) {
      this._set('stack', 'ok', this._on('horizon')
        ? t('msg.stackPortOpen', { pods: detail(probes.pods, ''), port })
        : detail(probes.pods, ''));
    } else if (podsOk) {
      this._set('stack', 'warn', t('msg.stackPortClosed', { pods: detail(probes.pods, ''), port }));
    } else {
      this._set('stack', 'idle', detail(probes.pods, t('msg.stackNotReady')));
    }

    const net = probes.network;
    if (net) this._set('network', net.ok ? 'ok' : 'idle', net.detail || '');

    const tp = probes.telepresence;
    if (tp) {
      this._set('telepresence', tp.ok ? 'ok' : (tp.warn ? 'error' : 'idle'), tp.detail || '');
      this._set('intercept', tp.intercepted ? 'ok' : 'idle',
        tp.intercepted ? t('msg.intercepted', { port: this.cfg.ports.gameServer }) : t('msg.notIntercepted'));
    }

    const gs = probes.gameServer;
    if (gs && typeof gs.ok === 'boolean') {
      // FIGE is neither ok nor idle: something IS there, and that is exactly the trap. A green step
      // over a wedged server is worse than a red one over nothing.
      if (gs.ok && gs.alive === false) {
        this._set('godot-server', 'error', t('msg.serverFrozen', { pid: gs.listenPid }));
      } else {
        this._set('godot-server', gs.ok ? 'ok' : 'idle',
          gs.ok ? t('msg.serverListening', { port: this.cfg.ports.gameServer, pid: gs.listenPid })
                : t('msg.nothingListens', { port: this.cfg.ports.gameServer }));
      }
      this._set('relink', gs.linked ? 'ok' : 'idle', gs.linked ? t('msg.linkUp') : t('msg.linkDown'));
    }
  }

  _set(id, state, message = '') {
    const step = this.chain.steps.find((s) => s.id === id);
    if (!step) return;
    step.state = state;
    step.message = message;
    this.emit('change');
  }

  _reset() {
    for (const s of this.chain.steps) {
      s.state = 'idle';
      s.message = '';
    }
    this.emit('change');
  }

  // --- individual services --------------------------------------------------

  /**
   * Docker Desktop is a GUI app: launch it detached and forget about it, then wait
   * for the engine itself (`docker info`) rather than for the window.
   */
  async startDocker(signal) {
    let probe = await this.probes.docker();
    if (probe.ok) {
      this._set('docker', 'ok', t('msg.alreadyStarted', { detail: probe.detail }));
      return true;
    }

    this._set('docker', 'running', t('msg.dockerStarting'));
    this.log.note('Starting Docker (the engine often takes one or two minutes to answer).');
    const started = await platform.startDockerEngine(this.cfg);
    if (!started.launched) {
      // Not fatal on its own: the daemon may already be coming up, or be a system
      // service we are not allowed to start. Say what happened and keep waiting.
      this.log.note('Docker: ' + started.detail, 'WARN');
    }

    const ready = await waitFor(async () => (await this.probes.docker()).ok, {
      timeoutMs: this.cfg.timeouts.dockerReadyMs,
      intervalMs: 3000,
      signal,
    });

    if (!ready) {
      this._set('docker', 'error', t('msg.dockerUnreachable'));
      return false;
    }
    probe = await this.probes.docker();
    this._set('docker', 'ok', probe.detail);
    return true;
  }

  /** Name of the k3d cluster (setting k3d.cluster, as start-dev's K3D_CLUSTER). */
  clusterName() {
    return (this.cfg.k3d && this.cfg.k3d.cluster) || 'dyingstar';
  }

  /**
   * Arguments of `k3d cluster create`, exactly as start-dev gives them: the repository mount (a
   * volume cannot be added to an existing cluster, and ArgoCD's file:///mnt/local-repo.git would
   * be empty), the published ports, and k3s's own Traefik switched off (ArgoCD deploys its own).
   * A Windows path (C:\x) becomes /c/x: the drive letter's colon breaks the --volume syntax.
   */
  k3dCreateArgs() {
    let repo = String(this.cfg.paths.kubernetesRepo || '').replace(/\\/g, '/');
    const m = repo.match(/^([A-Za-z]):(.*)$/);
    if (m) repo = '/' + m[1].toLowerCase() + m[2];
    return ['cluster', 'create', this.clusterName(), '--agents', '0', '--wait',
      '--volume', repo + ':/mnt/local-repo.git@all',
      '-p', '80:80@loadbalancer', '-p', '443:443@loadbalancer',
      '-p', '8443:8443@loadbalancer', '-p', '30101:30101/udp@loadbalancer',
      '--k3s-arg', '--disable=traefik@server:*'];
  }

  async startK3d(signal) {
    let probe = await this.probes.k3d();
    if (probe.ok) {
      this._set('k3d', 'ok', t('msg.alreadyRunning'));
      await this.raiseInotifyLimits();
      return true;
    }

    // Never (re)start the cluster while Telepresence is connected: it registers a DNS search domain
    // that Docker copies into the k3d node containers, and in-cluster lookups then break. The
    // repository's start-dev does the same. Harmless when Telepresence is absent or not connected.
    await run('telepresence', ['quit', '-s'], { timeoutMs: 20000 });

    // An existing cluster is started; otherwise it is created (and started by the creation).
    const exists = (await run('k3d', ['cluster', 'list', this.clusterName()], { timeoutMs: 20000 })).code === 0;
    this._set('k3d', 'running', t('msg.k3dStarting'));
    this.procs.start({
      id: 'k3d-start',
      label: exists ? 'k3d cluster start' : 'k3d cluster create',
      source: 'k3d',
      cmd: 'k3d',
      args: exists ? ['cluster', 'start', this.clusterName()] : this.k3dCreateArgs(),
    });

    // Say what is being waited for whenever it changes: a silent wait looks like a hang.
    let lastDetail = '';
    const ready = await waitFor(async () => {
      this.probes.invalidate('k3d');
      const pr = await this.probes.k3d();
      if (!pr.ok && pr.detail !== lastDetail) {
        lastDetail = pr.detail;
        this.log.note('Waiting for the k3d cluster: ' + pr.detail, 'INFO');
      }
      return pr.ok;
    }, {
      timeoutMs: this.cfg.timeouts.k3dReadyMs,
      intervalMs: 4000,
      signal,
    });

    if (!ready) {
      this._set('k3d', 'error', t('msg.clusterNoAnswer'));
      return false;
    }
    // k3d switches the kube context itself on creation; a plain start leaves it as it was.
    await run('kubectl', ['config', 'use-context', 'k3d-' + this.clusterName()], { timeoutMs: 15000 });
    probe = await this.probes.k3d();
    this._set('k3d', 'ok', probe.detail);
    await this.raiseInotifyLimits();
    return true;
  }

  /**
   * Raise the inotify limits, as start-dev does (step 1b). The defaults (max_user_instances=128) are
   * far too low once dozens of pods mount ConfigMaps/Secrets: horizon then dies with "too many open
   * files" (fsnotify watcher). The k3d nodes are privileged containers, so `docker exec` sets the
   * sysctls at once -- no pod to schedule, no image to pull into a cold cluster (~90 s before).
   * They are the kernel's own and are lost on a reboot, hence on every start. Idempotent and
   * best-effort: never fails the chain.
   */
  async raiseInotifyLimits() {
    const listed = await run('docker', ['ps', '--format', '{{.Names}}', '--filter',
      'name=^k3d-' + this.clusterName() + '-(server|agent)-'], { timeoutMs: 15000 });
    const nodes = listed.code === 0 ? listed.stdout.split(/\r?\n/).map((n) => n.trim()).filter(Boolean) : [];
    if (!nodes.length) {
      this.log.note('Could not raise the inotify limits: no k3d node container found.', 'WARN');
      return false;
    }
    let ok = true;
    for (const node of nodes) {
      const r = await run('docker', ['exec', node, 'sh', '-c',
        'sysctl -w fs.inotify.max_user_watches=1048576 && sysctl -w fs.inotify.max_user_instances=8192'],
      { timeoutMs: 20000 });
      if (r.code !== 0) {
        ok = false;
        this.log.note('Could not raise the inotify limits on ' + node + ': ' + (r.stderr || '').trim(), 'WARN');
      }
    }
    if (ok) this.log.note('inotify limits raised in the k3d node(s).', 'INFO');
    return ok;
  }

  /**
   * The repository's scripts refuse to run on any context other than the k3d one -- a deliberate
   * guard against deploying dev images to a real cluster. Fix it automatically rather than failing
   * the chain, but say so out loud.
   */
  async ensureContext() {
    this.probes.invalidate('kubeContext'); // the cluster start has just rewritten it
    let ctx = await this.probes.kubeContext();
    if (ctx.ok) {
      this._set('context', 'ok', ctx.detail);
      return true;
    }
    this._set('context', 'running', t('msg.switchingContext', { context: ctx.expected }));
    this.log.note('Kube context is "' + ctx.detail + '", switching to "' + ctx.expected + '".', 'WARN');
    await run('kubectl', ['config', 'use-context', ctx.expected], { timeoutMs: 15000 });
    this.probes.invalidate('kubeContext');
    ctx = await this.probes.kubeContext();
    this._set('context', ctx.ok ? 'ok' : 'error', ctx.detail);
    return ctx.ok;
  }

  /**
   * The repository's start-dev script: it creates the cluster when there is none, installs ArgoCD
   * and hands it the applications. Which script and which shell is the platform layer's business.
   */
  startStack(extraArgs = []) {
    const { cmd, args } = platform.stackStartCommand(this.cfg, extraArgs, this.wantedSets());
    // The cluster's name is start-dev's K3D_CLUSTER. Its size is Docker's own (Docker Desktop:
    // Settings > Resources): there is nothing to hand over.
    const env = { K3D_CLUSTER: this.clusterName() };
    return this.procs.start({
      id: 'stack',
      label: 'k8s stack (start-dev)',
      source: 'stack',
      cmd,
      args,
      env,
      // start-dev mounts $PWD into the k3d nodes (--volume $PWD:/mnt/local-repo.git): without the
      // repository as cwd, ArgoCD's "local-repo" volume points at the wrong folder.
      cwd: this.cfg.paths.kubernetesRepo,
    });
  }

  /**
   * Is the k8s stack already answering for itself? Every pod ready AND horizon's port open --
   * the two conditions the chain actually waits for, asked once instead of waited on.
   *
   * Returns the human-readable detail on success, null otherwise, so the caller can report the
   * same wording either way.
   */
  async stackAlreadyUp() {
    // Without the horizon module the pods alone speak for the stack.
    if (!this._on('horizon')) {
      const pods = await this.probes.pods();
      return pods.ok ? pods.detail : null;
    }
    const [port, pods] = await Promise.all([this.probes.horizonRoute(), this.probes.pods()]);
    if (port.ok && pods.ok) {
      return t('msg.stackPortOpen', { pods: pods.detail, port: this.cfg.ports.horizon });
    }
    return null;
  }

  /**
   * Is the stack INSTALLED in this cluster, whether or not its pods are up yet?
   *
   * The difference matters right after the machine restarts: the cluster is back in seconds, its
   * thirty pods take minutes. "Not ready" then means "wait", not "install" -- and running
   * start-dev there fails for want of administrator rights, taking the whole sequence with it.
   * ArgoCD's own server is the marker: it is the first thing start-dev installs.
   */
  async stackInstalled() {
    const r = await run('kubectl', ['get', 'deployment', 'argocd-server', '-n', 'argocd', '-o', 'name'],
      { timeoutMs: 15000 });
    return r.code === 0 && !!r.stdout.trim();
  }

  /**
   * Wait for the pods (and horizon's door). With `watchProcess` the wait is tied to the start-dev
   * process the panel launched and gives up when it dies; without, the stack is only coming back
   * and there is no process to watch.
   */
  async waitStackReady(signal, { watchProcess = true } = {}) {
    let lastWaitKey = '';
    const ready = await waitFor(async () => {
      // Bail out early if start-dev died: no point waiting the full timeout.
      // start-dev ending cleanly (code 0) is NORMAL: with --no-tunnel it exits as soon as the
      // ArgoCD applications are created, and the pods come up afterwards. Only a failure counts.
      if (watchProcess && !this.procs.isRunning('stack')) {
        const rec = this.procs.get('stack');
        if (!rec || rec.status !== 'stopped' || rec.exitCode !== 0) return 'dead';
      }
      const pods = await this.probes.pods();
      const port = this._on('horizon') ? await this.probes.horizonRoute() : { ok: true };
      if (port.ok && pods.ok) return 'ready';
      // Say WHAT is awaited whenever it changes: a silent wait looks like a hang. A pod that
      // never gets ready (crashloop, image not pulled, dependency down) is named here.
      const waiting = (pods.pods || []).filter((x) => !x.done && !x.allReady)
        .map((x) => x.name + ' (' + x.phase + (x.restarts ? ', ' + x.restarts + ' restarts' : '') + ')');
      const key = waiting.join('|') + (port.ok ? '' : '|horizon:' + port.detail);
      if (key !== lastWaitKey) {
        lastWaitKey = key;
        const parts = [];
        if (!pods.ok) parts.push(pods.detail + (waiting.length ? ' -- waiting for: ' + waiting.slice(0, 8).join(', ')
          + (waiting.length > 8 ? ' (+' + (waiting.length - 8) + ')' : '') : ''));
        if (!port.ok) parts.push('horizon: ' + port.detail);
        if (parts.length) this.log.note('Waiting for the stack: ' + parts.join(' / '), 'INFO');
      }
      return null;
    }, { timeoutMs: this.cfg.timeouts.stackReadyMs, intervalMs: 4000, signal });

    if (ready === 'dead') {
      this._set('stack', 'error', t('msg.startDevDied'));
      return false;
    }
    if (!ready) {
      this._set('stack', 'error', t('msg.stackTimeout', { port: this.cfg.ports.horizon }));
      return false;
    }
    const pods = await this.probes.pods();
    this._set('stack', 'ok', t('msg.stackPortOpen', { pods: pods.detail, port: this.cfg.ports.horizon }));
    return true;
  }

  /**
   * Delete the cluster (the repository's clean-dev script): k3d and everything in it, the
   * databases included. Never called on panel shutdown -- closing the panel must not destroy the
   * cluster. This is the explicit, confirmed, red button.
   */
  deleteCluster() {
    const { cmd, args } = platform.stackStopCommand(this.cfg);
    return this.procs.start({ id: 'clean-dev', label: 'clean-dev', source: 'stack', cmd, args, cwd: this.cfg.paths.kubernetesRepo });
  }

  /**
   * Clean the whole environment: everything stopAll stops, plus orphan game servers, the
   * Telepresence session and a stale port-forward, then the cluster itself (clean-dev). Irreversible.
   */
  async cleanEnv() {
    this.log.note('=== Cleaning the environment ===');
    await this.stopAll({ stopCluster: false });
    await this.godot.killOrphanServers();
    await run('telepresence', ['quit', '-s'], { timeoutMs: 20000 }).catch(() => {});
    this.deleteCluster();
    return { ok: true };
  }

  async stopStack() {
    await this.procs.stop('stack');
    // Only the script's process tree is stopped. The deployments stay in place, and so does the
    // world data in the emptyDir-backed databases.
    this.log.note('start-dev stopped. The deployments stay in place (databases untouched).');
  }

  // --- the whole chain ------------------------------------------------------

  async startAll({ withClients = 0 } = {}) {
    if (this.chain.running) {
      this.log.note('A start sequence is already running.', 'WARN');
      return { ok: false, detail: 'already running' };
    }

    this.chain.running = true;
    this._abort = new AbortController();
    const signal = this._abort.signal;
    this._reset();
    this.log.note('=== Starting the whole dev environment ===');
    this.emit('change');

    const fail = (why) => {
      this.log.note('Start sequence stopped: ' + why, 'ERROR');
      this.chain.running = false;
      this.emit('change');
      return { ok: false, detail: why };
    };

    try {
      if (this._on('docker')) {
        if (!await this.startDocker(signal)) return fail('Docker unavailable');
        if (signal.aborted) return fail('cancelled');
      }

      if (this._on('cluster')) {
        if (!await this.startK3d(signal)) return fail('k3d cluster unavailable');
        if (signal.aborted) return fail('cancelled');

        if (!await this.ensureContext()) return fail('wrong kube context');
        if (signal.aborted) return fail('cancelled');

        // Ask the CONDITION before launching anything -- the same rule startServer() follows on
        // the game-server port. ArgoCD keeps the deployment running long after the panel is
        // closed, so most of the time there is nothing to start; and start-dev wants elevated
        // rights for its tunnel and the hosts file. Launching it on a healthy stack aborted the
        // whole sequence while every probe was green.
        const deployed = await this.stackAlreadyUp();
        if (deployed) {
          this._set('stack', 'ok', t('msg.alreadyDeployed', { detail: deployed }));
        } else if (await this.stackInstalled()) {
          // Installed, just not back yet (the machine restarted): nothing to launch, only to wait.
          this._set('stack', 'running', t('msg.stackComingBack'));
          this.log.note('The stack is installed; waiting for its pods to come back (start-dev is not needed).');
          if (!await this.waitStackReady(signal, { watchProcess: false })) return fail('k8s stack not ready');
        } else {
          if (!this.procs.isRunning('stack')) {
            this._set('stack', 'running', t('msg.deploying'));
            this.startStack();
          } else {
            this._set('stack', 'running', t('msg.waitingPods'));
          }
          if (!await this.waitStackReady(signal)) return fail('k8s stack not ready');
        }
        if (signal.aborted) return fail('cancelled');
      }

      // The way in, once the cluster answers: the ports it publishes. (The hosts file is not written
      // here: it needs a permission prompt, which belongs to a button, not to a start sequence.)
      if (this._on('network') && this.network) {
        this._set('network', 'running', t('msg.netChecking'));
        const repaired = await this.network.ensurePorts();
        const state = await this.network.status();
        this._set('network', state.ok ? 'ok' : (repaired.ok ? 'warn' : 'error'), state.ok ? state.detail : (repaired.ok ? state.detail : repaired.detail));
        if (!repaired.ok) return fail('network: ' + repaired.detail);
        if (signal.aborted) return fail('cancelled');
      }

      // Telepresence, the documented way to run the game server locally: connect once the cluster
      // answers (never before -- and the cluster step above quits any earlier session), intercept
      // once the local server listens, so the traffic never lands on a closed port.
      const useTelepresence = this._on('telepresence') && !!this.telepresence;
      if (useTelepresence) {
        if (!await this._connectTelepresence(signal)) return fail('Telepresence not connected');
        if (signal.aborted) return fail('cancelled');
      }

      if (this._on('gameServer')) {
        const listening = await this._startLocalServer(signal);
        if (!listening.ok) return fail(listening.why);

        if (useTelepresence) {
          if (!await this._interceptGameServer(signal)) return fail('game server not intercepted');
          if (signal.aborted) return fail('cancelled');
        }

        // Now, and only now, point horizon at the fresh server. Without the relink module the
        // local server simply runs on its own.
        if (this._on('relink')) {
          this._set('relink', 'running', t('msg.restartingHorizon'));
          this.relink.adopt(listening.pid);
          const linked = await this.relink.relink('full start');
          if (!linked.ok) {
            this._set('relink', 'error', linked.detail);
            return fail('horizon link not established');
          }
          this._set('relink', 'ok', t('msg.linkUp'));
          this.relink.start();
        }
      }

      if (withClients > 0 && this._on('clients')) {
        this.godot.startClients(withClients)
          .catch((err) => this.log.note('Clients not started: ' + err.message, 'ERROR'));
      }

      this.log.note('=== Environment ready. You can enter the universe. ===');
      this.chain.running = false;
      this.emit('change');
      return { ok: true };
    } catch (err) {
      return fail(String(err && err.message));
    }
  }

  /** Connect Telepresence unless it already is. The user may have to accept a permission prompt. */
  async _connectTelepresence(signal) {
    let status = await this.telepresence.probe();
    if (!status.ok) {
      this._set('telepresence', 'running', t('msg.tpConnecting'));
      this.telepresence.connect();
      await waitFor(async () => {
        status = await this.telepresence.probe();
        return status.ok || status.warn || (!this.procs.isRunning('telepresence') && !status.connected ? 'dead' : null);
      }, { timeoutMs: 180000, intervalMs: 2000, signal });
      // The command may end a moment before the daemons report "Connected": ask once more.
      if (!status.ok) status = await this.telepresence.probe();
    }
    this._set('telepresence', status.ok ? 'ok' : 'error', status.ok ? status.detail : (status.warn ? status.detail : t('msg.tpFailed')));
    return status.ok;
  }

  /** Send the cluster's game-server traffic to the local server, unless it already comes here. */
  async _interceptGameServer(signal) {
    if (!await this.telepresence.intercepted()) {
      this._set('intercept', 'running', t('msg.intercepting'));
      this.telepresence.intercept();
      await waitFor(() => this.telepresence.intercepted(), { timeoutMs: 120000, intervalMs: 2500, signal });
    }
    const done = await this.telepresence.intercepted();
    this._set('intercept', done ? 'ok' : 'error',
      done ? t('msg.intercepted', { port: this.cfg.ports.gameServer }) : t('msg.interceptFailed'));
    return done;
  }

  /** The local game server step: start it, wait until it listens. Resolves { ok, pid } or { ok: false, why }. */
  async _startLocalServer(signal) {
    this._set('godot-server', 'running', t('msg.serverStarting'));
    // startServer clears stale headless servers itself -- but only after checking that nothing
    // holds the port, so it can never reap a server that is alive.
    await this.godot.startServer();

    const listening = await waitFor(async () => {
      const gs = await this.probes.gameServer();
      if (gs.listenPid != null) return gs;
      // Nobody listens yet: if our process is gone too, it will never come.
      return this.procs.isRunning('godot-server') ? null : 'dead';
    }, { timeoutMs: this.cfg.timeouts.gameServerReadyMs, intervalMs: 2000, signal });

    if (listening === 'dead') {
      this._set('godot-server', 'error', t('msg.serverDied'));
      return { ok: false, why: 'the Godot server stopped' };
    }
    if (!listening) {
      this._set('godot-server', 'error', t('msg.nothingListens', { port: this.cfg.ports.gameServer }));
      return { ok: false, why: 'the Godot server does not listen' };
    }
    this._set('godot-server', 'ok',
      t('msg.serverListening', { port: this.cfg.ports.gameServer, pid: listening.listenPid }));
    return { ok: true, pid: listening.listenPid };
  }

  abort() {
    if (this._abort) this._abort.abort();
    this.chain.running = false;
    this.log.note('Start sequence cancelled.', 'WARN');
    this.emit('change');
  }

  /**
   * Shut down in reverse order. The cluster is left running by default: stopping it is
   * slow to undo and rarely what you want between two work sessions.
   */
  async stopAll({ stopCluster = false } = {}) {
    this.log.note('=== Stopping the environment ===');
    this.relink.stop();
    await this.godot.stopClients();
    await this.procs.stop('godot-editor');
    await this.procs.stop('godot-server');
    await this.procs.stop('port-forward');
    await this.stopStack();

    if (stopCluster) {
      this.log.note('Stopping the k3d cluster...');
      await run('k3d', ['cluster', 'stop', this.clusterName()], { timeoutMs: 180000 });
    }

    this._reset();
    await sleep(200);
    this.log.note('=== Environment stopped ===');
    this.emit('change');
    return { ok: true };
  }
}

module.exports = { Services, STEPS };
