'use strict';

const { EventEmitter } = require('node:events');
const { run, waitFor, sleep } = require('./util');
const platform = require('./platform');
const { t } = require('./i18n');

/**
 * The start chain.
 *
 * Each step has a readiness gate that tests the thing that actually matters, not
 * "did the command return". That distinction is the whole point: `minikube start`
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
  { id: 'minikube', module: 'cluster' },
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
   * The same mistake in reverse hurts just as much: reopening the panel showed Docker, minikube,
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
    this._set('minikube', ok(probes.minikube) ? 'ok' : 'idle',
      detail(probes.minikube, t('msg.clusterStopped')));
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

  async startMinikube(signal) {
    let probe = await this.probes.minikube();
    if (probe.ok) {
      this._set('minikube', 'ok', t('msg.alreadyRunning'));
      await this.raiseInotifyLimits();
      return true;
    }

    // Never (re)start minikube while Telepresence is connected: it registers a DNS search domain
    // that Docker copies into the minikube container, and in-cluster lookups then break. The
    // repository's start-dev does the same. Harmless when Telepresence is absent or not connected.
    await run('telepresence', ['quit', '-s'], { timeoutMs: 20000 });

    this._set('minikube', 'running', t('msg.minikubeStarting'));
    this.procs.start({
      id: 'minikube-start',
      label: 'minikube start',
      source: 'minikube',
      cmd: 'minikube',
      args: this.cfg.minikube.startArgs,
    });

    const ready = await waitFor(async () => (await this.probes.minikube()).ok, {
      timeoutMs: this.cfg.timeouts.minikubeReadyMs,
      intervalMs: 4000,
      signal,
    });

    if (!ready) {
      this._set('minikube', 'error', t('msg.clusterNoAnswer'));
      return false;
    }
    probe = await this.probes.minikube();
    this._set('minikube', 'ok', probe.detail);
    await this.raiseInotifyLimits();
    return true;
  }

  /**
   * Raise the inotify limits inside the minikube node, as start-dev.sh does (step 1b). The node's
   * defaults (max_user_instances=128) are far too low once dozens of pods mount ConfigMaps/Secrets:
   * horizon then dies with "too many open files" (fsnotify watcher). Applied through a privileged
   * pod that nsenters the node, and written to /etc/sysctl.d; a node recreated by `minikube delete`
   * needs it again, hence on every start. Idempotent and best-effort: never fails the chain.
   */
  async raiseInotifyLimits() {
    const script = 'sysctl -w fs.inotify.max_user_watches=1048576 && sysctl -w fs.inotify.max_user_instances=8192'
      + " && printf 'fs.inotify.max_user_watches=1048576\\nfs.inotify.max_user_instances=8192\\n'"
      + ' > /etc/sysctl.d/99-inotify.conf';
    const overrides = JSON.stringify({
      spec: {
        hostPID: true,
        tolerations: [{ operator: 'Exists' }],
        containers: [{
          name: 'fix',
          image: 'busybox:1.37',
          securityContext: { privileged: true },
          command: ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '--', 'sh', '-c'],
          args: [script],
        }],
      },
    });
    const kc = (args, ms) => run('kubectl', ['-n', 'kube-system', ...args], { timeoutMs: ms });
    await kc(['delete', 'pod', 'inotify-fix', '--ignore-not-found', '--wait=true'], 30000);
    const created = await run('kubectl', ['run', 'inotify-fix', '-n', 'kube-system', '--image=busybox:1.37',
      '--restart=Never', '--overrides=' + overrides], { timeoutMs: 30000 });
    if (created.code !== 0) {
      this.log.note('Could not raise the inotify limits: ' + (created.stderr || '').trim(), 'WARN');
      return false;
    }
    const done = await kc(['wait', '--for=jsonpath={.status.phase}=Succeeded', 'pod/inotify-fix', '--timeout=90s'], 100000);
    await kc(['delete', 'pod', 'inotify-fix', '--wait=false'], 15000);
    if (done.code !== 0) {
      this.log.note('The inotify limits may not have been raised (pod did not finish).', 'WARN');
      return false;
    }
    this.log.note('inotify limits raised in the minikube node.', 'INFO');
    return true;
  }

  /**
   * The repository's scripts refuse to run on any context other than minikube -- a deliberate
   * guard against deploying dev images to a real cluster. Fix it automatically rather than failing
   * the chain, but say so out loud.
   */
  async ensureContext() {
    let ctx = await this.probes.kubeContext();
    if (ctx.ok) {
      this._set('context', 'ok', ctx.detail);
      return true;
    }
    this._set('context', 'running', t('msg.switchingContext', { context: ctx.expected }));
    this.log.note('Kube context is "' + ctx.detail + '", switching to "' + ctx.expected + '".', 'WARN');
    await run('kubectl', ['config', 'use-context', ctx.expected], { timeoutMs: 15000 });
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
    // minikube's size is only taken at creation, which is start-dev's job: hand it over by env.
    const env = {};
    if (this.cfg.minikube.cpus) env.MINIKUBE_CPUS = String(this.cfg.minikube.cpus);
    if (this.cfg.minikube.memory) env.MINIKUBE_MEMORY = String(this.cfg.minikube.memory);
    return this.procs.start({
      id: 'stack',
      label: 'k8s stack (start-dev)',
      source: 'stack',
      cmd,
      args,
      env,
      // start-dev mounts $PWD into minikube (--mount-string $PWD:/mnt/local-repo.git): without the
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
   * The difference matters right after the machine restarts: minikube is back in seconds, its
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
    const ready = await waitFor(async () => {
      // Bail out early if start-dev died: no point waiting the full timeout.
      if (watchProcess && !this.procs.isRunning('stack')) return 'dead';
      const pods = await this.probes.pods();
      const port = this._on('horizon') ? await this.probes.horizonRoute() : { ok: true };
      if (port.ok && pods.ok) return 'ready';
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
   * Delete the cluster (the repository's clean-dev script): minikube and everything in it, the
   * databases included. Never called on panel shutdown -- closing the panel must not destroy the
   * cluster. This is the explicit, confirmed, red button.
   */
  deleteCluster() {
    const { cmd, args } = platform.stackStopCommand(this.cfg);
    return this.procs.start({ id: 'clean-dev', label: 'clean-dev', source: 'stack', cmd, args, cwd: this.cfg.paths.kubernetesRepo });
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
        if (!await this.startMinikube(signal)) return fail('minikube unavailable');
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

      // The way in, once the cluster answers: relays that match it. (The hosts file is not written
      // here: it needs a permission prompt, which belongs to a button, not to a start sequence.)
      if (this._on('network') && this.network) {
        this._set('network', 'running', t('msg.netRepairing'));
        const repaired = await this.network.ensureRelays();
        const state = await this.network.status();
        this._set('network', state.ok ? 'ok' : (repaired.ok ? 'warn' : 'error'), state.ok ? state.detail : (repaired.ok ? state.detail : repaired.detail));
        if (!repaired.ok) return fail('network: ' + repaired.detail);
        if (signal.aborted) return fail('cancelled');
      }

      // Telepresence, the documented way to run the game server locally: connect once the cluster
      // answers (never before -- and the minikube step above quits any earlier session), intercept
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
   * Shut down in reverse order. minikube is left running by default: stopping it is
   * slow to undo and rarely what you want between two work sessions.
   */
  async stopAll({ stopMinikube = false } = {}) {
    this.log.note('=== Stopping the environment ===');
    this.relink.stop();
    await this.godot.stopClients();
    await this.procs.stop('godot-editor');
    await this.procs.stop('godot-server');
    await this.procs.stop('port-forward');
    await this.stopStack();

    if (stopMinikube) {
      this.log.note('Stopping minikube...');
      await run('minikube', ['stop'], { timeoutMs: 180000 });
    }

    this._reset();
    await sleep(200);
    this.log.note('=== Environment stopped ===');
    this.emit('change');
    return { ok: true };
  }
}

module.exports = { Services, STEPS };
