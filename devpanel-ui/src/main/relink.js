'use strict';

const { EventEmitter } = require('node:events');
const { run, sleep } = require('./util');

/**
 * Keeps horizon linked to the local game server.
 *
 * Horizon used to connect to the game server exactly ONCE, at its own startup: every restart of
 * the server (an F5 in the editor, or the panel restarting it) left horizon bound to a dead
 * socket, and the player spawned but could not move. The remedy was mechanical: watch which PID
 * listens on the game-server port, and restart horizon when it changes.
 *
 * Horizon now finds the game server again BY ITSELF, within a second or two of it listening, and
 * hands it the world then. Restarting horizon in that window is not just useless: it throws the
 * fresh link away, and the few seconds of reconnection read as "link dropped" to a watcher in a
 * hurry, which then restarted the game server and horizon a second time (2026-11-19).
 *
 * So the watcher now WAITS FIRST: a new server, or a dropped link, gets `relink.graceMs` to come
 * back on its own. Horizon is only restarted when it has not -- which keeps the remedy for an
 * older horizon, and for the day the reconnection fails.
 */
// How often the watcher looks at the game-server port.
const TICK_MS = 2000;

class RelinkWatcher extends EventEmitter {
  constructor({ config, probes, log, godot }) {
    super();
    this.cfg = config;
    this.probes = probes;
    this.log = log;
    this.godot = godot || null;
    // Optional `async () => boolean`: can horizon reach the local server at all? (With
    // Telepresence: is the cluster's game server intercepted?) While the answer is no, restarting
    // horizon cannot create the link, so the watcher leaves it alone. Set by the owner.
    this.canLink = null;
    this._canLinkAt = 0;
    this._canLinkValue = true;
    this._saidNoRoad = false;

    this.enabled = false;
    this.running = false;
    this.lastPid = null;
    this.zeroCount = 0;
    this.status = 'stopped';   // stopped | watching | relinking
    this.lastRelinkAt = null;
    // null = never checked yet; false = horizon dumped the world with nobody listening.
    this.worldDelivered = null;
    // PID of the game server the world was last delivered TO. A relink onto that same server is a
    // RE-delivery, which is the thing to avoid -- see _restartIfAlreadyLoaded.
    this.worldDeliveredPid = null;
    this._abort = null;
    // Relinks that failed in a row. Rolling horizon cannot fix a stack whose problem is elsewhere
    // (a service crash-looping that horizon's init containers wait for): without a cap the watcher
    // rolled horizon every ~5 min, for hours, on 2026-09-29. See _giveUp.
    this.failStreak = 0;
    // The pods named as the cause the last time the watcher gave up, for state() and the log.
    this.blockedBy = [];
  }

  state() {
    return {
      enabled: this.enabled,
      status: this.status,
      lastPid: this.lastPid,
      lastRelinkAt: this.lastRelinkAt,
      worldDelivered: this.worldDelivered,
      blockedBy: this.blockedBy,
    };
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.status = 'watching';
    this.failStreak = 0;
    this.blockedBy = [];
    this._abort = new AbortController();
    this.log.note('Relink watcher started (watching port ' + this.cfg.ports.gameServer + ').');
    this._loop(this._abort.signal);
    this.emit('change');
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    this.status = 'stopped';
    if (this._abort) this._abort.abort();
    this.log.note('Relink watcher stopped.');
    this.emit('change');
  }

  /**
   * Adopt the PID of a server the panel just started, WITHOUT relinking.
   *
   * Used by the start chain: it restarts horizon itself as an explicit step, so the
   * watcher must not immediately fire a second, redundant rollout.
   */
  adopt(pid) {
    this.lastPid = pid;
    this.zeroCount = 0;
  }

  /** The answer of `canLink`, kept for a few seconds: it costs a `telepresence list`. */
  async _roadOpen() {
    if (!this.canLink) return true;
    if (Date.now() - this._canLinkAt < 8000) return this._canLinkValue;
    try {
      this._canLinkValue = !!(await this.canLink());
    } catch {
      this._canLinkValue = true;   // cannot tell: behave as before
    }
    this._canLinkAt = Date.now();
    return this._canLinkValue;
  }

  async _loop(signal) {
    while (!signal.aborted) {
      try {
        await this._tick(signal);
      } catch (err) {
        this.log.note('Relink watcher: ' + String(err && err.message), 'WARN');
      }
      await sleep(TICK_MS);
    }
    this.running = false;
  }

  _graceMs() {
    const ms = this.cfg.relink && this.cfg.relink.graceMs;
    return Number.isFinite(ms) && ms >= 0 ? ms : 45000;
  }

  /**
   * Did horizon come back to the game server on its own, world included?
   *
   * Polls the link for up to [param waitMs] (once at least). A link alone is not enough: the
   * server must also say it received the world, or the player would spawn unable to move.
   */
  async _linkedByItself(waitMs) {
    const deadline = Date.now() + waitMs;
    let announced = false;
    for (;;) {
      const gs = await this.probes.gameServer();
      if (gs && gs.listenPid != null && gs.linked) {
        if (!await this._worldDelivered(0)) return false;
        this.lastPid = gs.listenPid;
        this.worldDelivered = true;
        this.worldDeliveredPid = gs.listenPid;
        return true;
      }
      if (Date.now() >= deadline) return false;
      if (!announced) {
        announced = true;
        this.log.note('Relink: giving horizon ' + Math.round(waitMs / 1000) + ' s to find the game server by itself...');
      }
      await sleep(1000);
    }
  }

  async _tick(signal) {
    if (this.status === 'relinking') return;

    const gs = await this.probes.gameServer();
    if (signal.aborted) return;

    if (gs.listenPid == null) {
      if (this.lastPid != null) {
        this.log.note('Local Godot server stopped (nobody listens on ' + this.cfg.ports.gameServer + ' any more).');
        this.lastPid = null;
        this.emit('change');
      }
      this.zeroCount = 0;
      return;
    }

    if ((gs.listenPid !== this.lastPid || !gs.linked) && !(await this._roadOpen())) {
      // A local server with no road from horizon to it (not intercepted yet). Nothing is adopted:
      // the day the road opens, this server is handled like a new one.
      if (!this._saidNoRoad) {
        this._saidNoRoad = true;
        this.log.note('Relink watcher: a local server listens, but horizon has no road to it yet'
          + ' (game server not intercepted). Waiting, horizon is left alone.');
      }
      this.zeroCount = 0;
      return;
    }
    this._saidNoRoad = false;

    if (gs.listenPid !== this.lastPid) {
      // A new process owns the port: a fresh F5, or a server the panel restarted.
      const reason = 'new server detected (PID ' + gs.listenPid + ')';
      this.lastPid = gs.listenPid;
      this.zeroCount = 0;
      await this.relink(reason);
      return;
    }

    if (!gs.linked) {
      // Same server, but the link dropped. Horizon reconnects by itself: only after a whole grace
      // period without a link is it worth restarting. (It used to be three observations, ~6 s,
      // which is about how long a normal reconnection takes.)
      this.zeroCount += 1;
      if (this.zeroCount * TICK_MS >= this._graceMs()) {
        this.zeroCount = 0;
        await this.relink('link dropped', { waited: true });
      }
    } else {
      this.zeroCount = 0;
    }
  }

  /**
   * Make sure horizon is linked to the game server, restarting it only if it must.
   *
   * First horizon is given the grace period to reconnect by itself (see the top of this file).
   * Options: `force` restarts horizon without waiting (the manual button: the user asked for it);
   * `waited` says the caller already sat through the grace period.
   *
   * Two guards wrap the rollout, because a relink that "succeeds" can still leave you with a
   * world the game server never received -- which looks like a working link and a player who
   * cannot move. See _waitServerLoaded (before) and _worldDelivered (after).
   */
  async relink(reason, options = {}) {
    // One at a time. A second caller (the start chain arriving while the watcher is already at
    // it, or the reverse) gets the answer of the one in progress instead of a refusal.
    if (this._current) return this._current;
    this._current = this._relink(reason, options);
    try {
      return await this._current;
    } finally {
      this._current = null;
    }
  }

  async _relink(reason, { force = false, waited = false } = {}) {
    this.status = 'relinking';
    this.emit('change');

    if (!force) {
      await this._waitServerLoaded(0);
      if (await this._linkedByItself(waited ? 0 : this._graceMs())) {
        this.lastRelinkAt = Date.now();
        this.log.note('Relink: horizon found the game server by itself (' + reason
          + '): link established and world delivered, nothing to restart.');
        this._countFailure({ ok: true }, []);
        this.status = this.enabled ? 'watching' : 'stopped';
        this.emit('change');
        return { ok: true, detail: 'link established', restarted: false };
      }
    }

    // Default 1. Every extra attempt is a whole extra world delivery onto a server that may already
    // hold one, and a second delivery does not plateau -- it climbs. Retrying is the runaway.
    const maxAttempts = this.cfg.relink && this.cfg.relink.maxAttempts ? this.cfg.relink.maxAttempts : 1;
    let result = { ok: false, detail: 'relink not attempted' };

    // Guard 0 -- can the stack bring horizon up at all? If a pod it depends on is crash-looping,
    // rolling horizon only parks it in Init again: name the culprit instead of rolling for nothing.
    const crashing = await this._blockers(false);
    if (crashing.length) {
      this.log.note('Relink: no point restarting horizon, the stack is blocked elsewhere -> '
        + crashing.join(' ; '), 'ERROR');
      result = { ok: false, detail: 'stack blocked: ' + crashing.join(' ; ') };
      this._countFailure(result, crashing);
      this.status = this.enabled ? 'watching' : 'stopped';
      this.emit('change');
      return result;
    }

    await this._restartIfAlreadyLoaded();
    // Always wait for a LOADED server, not just a quiet one -- including when nothing was restarted
    // above. A server the user has just started by hand is still ingesting terrain, and rolling
    // horizon against it produces the same "no link" as a restarted one. sinceSeq 0 is safe: the log
    // is cleared when the server starts, so any marker in the buffer belongs to the current run.
    await this._waitServerLoaded(0);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const why = attempt === 1 ? reason : reason + ' (world not delivered, attempt ' + attempt + '/' + maxAttempts + ')';
      // Mark the log BEFORE the rollout: anything matching after this point is this delivery.
      const mark = this.log.seq;
      result = await this._rollHorizon(why);
      if (!result.ok) break;

      if (await this._worldDelivered(mark)) {
        this.worldDelivered = true;
        const gs = await this.probes.gameServer();
        this.worldDeliveredPid = gs && gs.listenPid ? gs.listenPid : null;
        this.lastRelinkAt = Date.now();
        this.log.note('Relink OK: link established and world delivered, you can enter the universe.');
        break;
      }

      this.worldDelivered = false;
      this.log.note('Relink: no object reached the game server after horizon restarted.'
        + ' A player would spawn without a spawn parent and could not move.', 'ERROR');
      if (attempt === maxAttempts) {
        result = { ok: false, detail: 'world not delivered after ' + maxAttempts + ' attempt(s)' };
        this.log.note('Relink: NOT retrying -- restarting horizon again would deliver the world a second'
          + ' time to a server that already holds one, and its memory climbs without levelling off.'
          + ' Restart the Godot server, then relink again.', 'ERROR');
      }
    }

    this._countFailure(result, result.ok ? [] : await this._blockers(true));
    this.status = this.enabled ? 'watching' : 'stopped';
    this.emit('change');
    return result;
  }

  /** Track failed relinks in a row; past the cap, stop watching rather than roll horizon forever. */
  _countFailure(result, blockers) {
    if (result.ok) {
      this.failStreak = 0;
      this.blockedBy = [];
      return;
    }
    this.failStreak += 1;
    const cap = (this.cfg.relink && this.cfg.relink.maxConsecutiveFailures) || 2;
    if (this.failStreak >= cap) this._giveUp(blockers);
  }

  _giveUp(blockers) {
    this.blockedBy = blockers;
    const cause = blockers.length
      ? 'Likely cause: ' + blockers.join(' ; ') + '.'
      : 'No failing pod in sight: check that the Godot server has loaded and listens on '
        + this.cfg.ports.gameServer + '.';
    this.log.note('Relink: ' + this.failStreak + ' failures in a row, the watcher stops rather than'
      + ' restart horizon forever. ' + cause + ' Fix it, then turn the watcher back on.', 'ERROR');
    this.failStreak = 0;
    this.stop();
  }

  /**
   * Pods keeping the stack from bringing horizon up, as readable one-liners. Empty when nothing is
   * visibly wrong -- or when kubectl cannot answer, so a flaky kubectl never blocks a relink.
   *
   * Always: any container crash-looping or failing to pull its image (the real culprit, usually).
   * With [withHorizonInit]: horizon parked in an init container, named, since that says WHO it
   * waits for. Only after a failure -- right after a rollout, sitting in Init is just normal.
   */
  async _blockers(withHorizonInit) {
    const ns = this.cfg.k8s.namespace;
    const res = await run('kubectl', ['get', 'pods', '-n', ns, '-o', 'json'], { timeoutMs: 20000 });
    if (res.code !== 0) return [];
    let pods = [];
    try {
      pods = JSON.parse(res.stdout || '{}').items || [];
    } catch {
      return [];
    }
    const BAD = ['CrashLoopBackOff', 'Error', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'];
    const out = [];
    for (const pod of pods) {
      const name = (pod.metadata && pod.metadata.name) || '?';
      const status = pod.status || {};
      if (status.phase === 'Succeeded') continue;
      for (const c of status.containerStatuses || []) {
        const reason = (c.state && c.state.waiting && c.state.waiting.reason)
          || (c.state && c.state.terminated && c.state.terminated.reason);
        if (reason && BAD.includes(reason)) {
          out.push(name + ': ' + reason + ' (' + c.restartCount + ' restarts)');
        }
      }
      if (withHorizonInit && name.startsWith(this.cfg.k8s.horizonDeployment + '-')) {
        const stuck = (status.initContainerStatuses || []).find((c) => !c.ready && !(c.state && c.state.terminated));
        if (stuck) out.push(name + ': stuck in init container ' + stuck.name);
      }
    }
    return out;
  }

  /** One rollout of horizon, waited until the link to the game server is back. */
  async _rollHorizon(reason) {
    const ns = this.cfg.k8s.namespace;
    const dep = this.cfg.k8s.horizonDeployment;
    this.log.note('Relink: ' + reason + ' -> restarting ' + dep + '...');

    // DELETE THE POD, never `rollout restart`.
    //
    // `rollout restart` writes the kubectl.kubernetes.io/restartedAt annotation INTO the
    // Deployment's template: to ArgoCD that is drift in the spec, which selfHeal reverts at
    // once -- a SECOND restart. And horizon hands the world over a few seconds after it boots
    // and never replays it: one restart too many and the world goes nowhere.
    //
    // Deleting the pod leaves the spec alone. The ReplicaSet recreates it, ArgoCD has nothing
    // to put right, and the result is exactly one restart.
    const sel = await run('kubectl', ['get', 'deployment', dep, '-n', ns,
      '-o', 'jsonpath={.spec.selector.matchLabels}'], { timeoutMs: 20000 });
    let selector = '';
    try {
      selector = Object.entries(JSON.parse(sel.stdout || '{}')).map(([k, v]) => k + '=' + v).join(',');
    } catch { /* unreadable selector: treated as empty just below */ }
    if (!selector) {
      this.log.note('Relink: could not read the selector of deployment ' + dep + '.', 'ERROR');
      return { ok: false, detail: 'selector not found' };
    }

    const restart = await run('kubectl', ['delete', 'pod', '-n', ns, '-l', selector], { timeoutMs: 60000 });
    if (restart.code !== 0) {
      this.log.note('Relink: could not delete the pod -> ' + (restart.stderr || restart.stdout).trim(), 'ERROR');
      return { ok: false, detail: 'pod deletion failed' };
    }

    await run('kubectl', ['rollout', 'status', 'deployment/' + dep, '-n', ns, '--timeout=120s'], { timeoutMs: 140000 });

    const deadline = Date.now() + (this.cfg.timeouts.relinkMs || 180000);
    while (Date.now() < deadline) {
      const gs = await this.probes.gameServer();
      if (gs.linked) {
        this.lastPid = gs.listenPid;
        return { ok: true, detail: 'link established' };
      }
      await sleep(2000);
    }

    this.log.note('Relink: no link after waiting. Has the Godot server finished loading?', 'ERROR');
    return { ok: false, detail: 'no link' };
  }

  /**
   * Restart the game server when it has ALREADY been given a world, before rolling horizon.
   *
   * Horizon dumps the whole world once, a few seconds after it boots, and never replays it. So a
   * relink is a fresh delivery -- harmless to a server that just started, ruinous to one already
   * holding it: every prop is re-created, each re-pins its terrain chunk on top of a residency that
   * is already populated, and the collision rebuild stops plateauing and simply climbs. Measured on
   * 2026-09-07: 9.5 -> 10.5 GB in fifteen seconds, ~64 MB/s, with 2179 chunk loads for 245 distinct
   * chunks. Left alone it reaches ~26 GB and takes minikube down with it.
   *
   * The watcher's own relink (you pressed F5) is NOT this case: that server is brand new and has
   * never been fed. Hence the PID test rather than a blanket restart.
   */
  async _restartIfAlreadyLoaded() {
    if (!this.godot || !this.worldDeliveredPid) return;
    const gs = await this.probes.gameServer();
    const pid = gs && gs.listenPid ? gs.listenPid : null;
    if (!pid || pid !== this.worldDeliveredPid) return;

    this.log.note('Relink: this server already received the world. Horizon is about to deliver it'
      + ' again, and a second delivery onto a full server makes its memory climb without levelling off.'
      + ' Restarting it first.');
    const since = this.log.search({ source: 'godot-server', limit: 1 });
    const sinceSeq = since.lines.length ? since.lines[since.lines.length - 1].i : 0;

    this.godot.stopServer();
    await this._waitPortFree();
    const started = await this.godot.startServer();
    if (!started || started.ok === false) {
      this.log.note('Relink: could not restart the server. Restart it by hand before relinking.', 'ERROR');
      return;
    }
    this.worldDelivered = false;
    this.worldDeliveredPid = null;

    // Claim the new PID before the watcher sees it. Without this it reads the change as "someone
    // pressed F5" and fires a SECOND relink behind this one -- a second world delivery, which is the
    // very thing this function exists to prevent.
    const fresh = await this._waitPortTaken();
    if (fresh) this.adopt(fresh);

    await this._waitServerLoaded(sinceSeq);
  }

  /** Wait for 8980 to be answered again, and return the PID that answers it. */
  async _waitPortTaken() {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const gs = await this.probes.gameServer();
      if (gs && gs.listenPid) return gs.listenPid;
      await sleep(500);
    }
    return null;
  }

  /**
   * Wait until the game server says it has finished loading, not merely that it went quiet.
   *
   * A server that has just been started is silent BEFORE it starts talking, so the silence test used
   * elsewhere passes immediately and horizon gets rolled against a server still ingesting terrain --
   * measured: the link never came up, the watcher then fired its own relink, and the second delivery
   * drove the server to 26 GB.
   *
   * The marker is the line server.gd prints when it is done ("server loaded"). Only lines newer than
   * [param sinceSeq] count, so a previous run's marker cannot satisfy this one.
   */
  async _waitServerLoaded(sinceSeq) {
    const maxMs = this.cfg.timeouts.serverSettleMs || 240000;
    const deadline = Date.now() + maxMs;
    let announced = false;

    while (Date.now() < deadline) {
      const hit = this.log.search({ source: 'godot-server', q: 'server loaded', limit: 1, sinceSeq });
      if (hit.lines.length) {
        this.log.note('Relink: the Godot server has finished loading, horizon can be restarted.');
        return true;
      }
      // Started outside the panel (an F5 in the editor): its output is not captured, so the marker can
      // never arrive. Do not hold the relink hostage to a server we cannot hear.
      const src = this.log.sourceList().find((x) => x.name === 'godot-server');
      if (!src || !src.last) return true;
      if (!announced) {
        announced = true;
        this.log.note('Relink: the Godot server is loading the world, waiting for it to finish...');
      }
      await sleep(2000);
    }
    this.log.note('Relink: the Godot server did not report the end of its loading after '
      + Math.round(maxMs / 1000) + ' s. Restarting horizon anyway.', 'WARN');
    return false;
  }

  /** Wait for 8980 to be released, so the fresh server can take it. */
  async _waitPortFree() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const gs = await this.probes.gameServer();
      if (!gs || !gs.listenPid) return true;
      await sleep(500);
    }
    this.log.note('Relink: port ' + this.cfg.ports.gameServer + ' is still held after 30 s.', 'WARN');
    return false;
  }

  /**
   * Guard 2 -- did the world actually reach the game server?
   *
   * Read this from the GAME SERVER, not from horizon. Horizon logs
   * "No handlers for event: plugin:gameserverplugin:init_server" on EVERY boot -- ds_props emits
   * that event and no plugin has ever registered a handler for it (grep the repo: the string
   * appears exactly once, at the emit site). Keying on it made this guard always say "lost", so
   * every relink rolled horizon three times and delivered the world three times over. That is a
   * memory runaway, not a repair.
   *
   * The honest proof is the server saying it received the delivery: once horizon has sent every
   * initial object, the Godot server prints "All initial objects loaded, starting simulation".
   * (It used to be each celestial body's "[Planet] _ready", but the planets are now built by the
   * server itself at boot, BEFORE the relink: that line never came after it, and every relink was
   * reported lost while the world had arrived.) sinceSeq is taken before the rollout, so a hit can
   * only belong to this delivery.
   */
  async _worldDelivered(sinceSeq) {
    const deadline = Date.now() + (this.cfg.timeouts.worldDeliveryMs || 120000);
    let announced = false;

    while (Date.now() < deadline) {
      const hit = this.log.search({ source: "godot-server", q: "All initial objects loaded", limit: 1, sinceSeq });
      if (hit.lines.length) return true;
      // Server started outside the panel (an F5 in the editor): we cannot hear it, so do not
      // pretend to judge -- say yes rather than roll horizon again for nothing.
      const src = this.log.sourceList().find((x) => x.name === "godot-server");
      if (!src || !src.last) return true;
      if (!announced) {
        announced = true;
        this.log.note('Relink: horizon is back, waiting for the objects to reach the server...');
      }
      await sleep(2000);
    }
    return false;
  }


}

module.exports = { RelinkWatcher };
