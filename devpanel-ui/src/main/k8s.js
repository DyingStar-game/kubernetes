'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run, waitFor } = require('./util');
const { portInfo, killTree, exposeHorizonCommand, buildAndDeployCommand, setsCommand } = require('./platform');
const { SET_IDS } = require('./modules');

/**
 * Cluster operations the panel exposes as buttons -- the gestures that otherwise mean opening a
 * terminal and retyping a long command.
 */
class K8s {
  constructor({ config, log, procs }) {
    this.cfg = config;
    this.log = log;
    this.procs = procs;
  }

  get ns() {
    return this.cfg.k8s.namespace;
  }

  async useMinikubeContext() {
    const ctx = this.cfg.k8s.expectedContext;
    const r = await run('kubectl', ['config', 'use-context', ctx], { timeoutMs: 15000 });
    const ok = r.code === 0;
    this.log.note(
      ok ? 'Kube context switched to ' + ctx + '.' : 'Could not switch the kube context: ' + r.stderr.trim(),
      ok ? 'INFO' : 'ERROR'
    );
    return { ok, detail: ok ? ctx : r.stderr.trim() };
  }

  /**
   * Restart a Deployment by deleting its pods, never with `rollout restart`: the latter writes an
   * annotation into the Deployment's template, which ArgoCD reads as drift and selfHeal reverts at
   * once -- a SECOND restart. Deleting the pods leaves the spec alone: exactly one restart.
   */
  async restartDeployment(name) {
    const sel = await run('kubectl', ['get', 'deployment', name, '-n', this.ns,
      '-o', 'jsonpath={.spec.selector.matchLabels}'], { timeoutMs: 20000 });
    let selector = '';
    try {
      selector = Object.entries(JSON.parse(sel.stdout || '{}')).map(([kk, v]) => kk + '=' + v).join(',');
    } catch { /* unreadable: reported just below */ }
    if (!selector) {
      this.log.note('Could not read the selector of deployment ' + name + '.', 'ERROR');
      return { ok: false, detail: 'selector not found' };
    }
    const r = await run('kubectl', ['delete', 'pod', '-n', this.ns, '-l', selector], { timeoutMs: 60000 });
    const ok = r.code === 0;
    this.log.note(
      ok ? 'Restart of ' + name + ' requested.' : 'Could not restart ' + name + ': ' + r.stderr.trim(),
      ok ? 'INFO' : 'ERROR'
    );
    return { ok, detail: ok ? 'pod deleted, being recreated' : r.stderr.trim() };
  }

  /** Delete a single pod: the deployment recreates it. Cheaper than a rollout when one pod is stuck. */
  async deletePod(name) {
    const r = await run('kubectl', ['delete', 'pod', name, '-n', this.ns], { timeoutMs: 30000 });
    const ok = r.code === 0;
    this.log.note(
      ok ? 'Pod ' + name + ' deleted (it will be recreated).' : 'Could not delete ' + name + ': ' + r.stderr.trim(),
      ok ? 'INFO' : 'ERROR'
    );
    return { ok, detail: ok ? 'deleted' : r.stderr.trim() };
  }

  async listDeployments() {
    const r = await run('kubectl', ['get', 'deployments', '-n', this.ns, '-o', 'json'], { timeoutMs: 20000 });
    if (r.code !== 0) return [];
    try {
      return (JSON.parse(r.stdout).items || []).map((d) => d.metadata.name).sort();
    } catch {
      return [];
    }
  }

  /**
   * The running pod whose name carries [param needle].
   *
   * Matched anywhere in the name, not just at the start: a chart pulled in as a SUBCHART is named
   * after its parent, so "scylladb" became "service-persistence-scylladb-<hash>" and a prefix test
   * stopped finding it -- the purge then failed with "no pod found" while the pod was right there.
   * A leading match still wins, so an exact component keeps priority over one that merely contains it.
   */
  async _findPod(needle) {
    const r = await run('kubectl', ['get', 'pods', '-n', this.ns, '-o', 'json'], { timeoutMs: 20000 });
    if (r.code !== 0) return null;
    try {
      const items = (JSON.parse(r.stdout).items || [])
        .filter((p) => (p.status?.phase || '') === 'Running');
      const named = items.map((p) => p.metadata?.name || '');
      return named.find((n) => n.startsWith(needle)) || named.find((n) => n.includes(needle)) || null;
    } catch {
      return null;
    }
  }

  /**
   * Empty the persisted world objects.
   *
   * Must go through cqlsh, not the REST API: godotserver re-upserts anything deleted
   * through the API, so the rows come straight back. After truncating, the game
   * server has to be reloaded for the change to be visible.
   */
  async purgeScylla() {
    const pod = await this._findPod('scylladb');
    if (!pod) {
      this.log.note('ScyllaDB purge: no scylladb pod found in ' + this.ns + '.', 'ERROR');
      return { ok: false, detail: 'scylladb pod not found' };
    }
    const ks = this.cfg.k8s.scyllaKeyspace;
    this.log.note('ScyllaDB purge on ' + pod + ': TRUNCATE ' + ks + '.items ...');
    const r = await run(
      'kubectl',
      ['exec', pod, '-n', this.ns, '--', 'cqlsh', '-e', 'TRUNCATE ' + ks + '.items;'],
      { timeoutMs: 60000 }
    );
    const ok = r.code === 0;
    this.log.note(
      ok
        ? 'ScyllaDB purged. Restart the game server for it to show.'
        : 'Purge failed: ' + (r.stderr || r.stdout).trim(),
      ok ? 'INFO' : 'ERROR'
    );
    return { ok, detail: ok ? 'items emptied' : (r.stderr || r.stdout).trim() };
  }

  /**
   * The horizon relay: a port-forward that FOLLOWS the pod.
   *
   * This is the second way in for a game client (the first is the ingress), and the only one
   * another machine on the LAN can use.
   */
  async startPortForward() {
    const port = this.cfg.ports.horizon;

    // Free the port FIRST. The usual reason for pressing this button is a tunnel that still holds
    // the port while pointing at a pod that no longer exists. It is not ours to manage through
    // procs, it answers a TCP connect perfectly, and it makes the new forward fail to bind. Without
    // this the button looked like it worked ("ok": true) and changed nothing.
    const { listenPid } = await portInfo(port);
    const ours = this.procs.get('port-forward');
    if (listenPid != null && listenPid !== (ours && ours.pid)) {
      this.log.note('Port ' + port + ' is held by PID ' + listenPid
        + ' (probably a stale tunnel): freeing it before starting the relay.', 'INFO');
      await killTree(listenPid);
      await waitFor(
        async () => (await portInfo(port)).listenPid == null,
        { timeoutMs: 5000, intervalMs: 250 }
      );
    }

    // The repository's expose-horizon script rather than a raw `kubectl port-forward`: the latter
    // resolves its pod ONCE and never follows a replacement, so every horizon rollout (a relink, a
    // build of the props image) leaves it listening into a corpse -- accepting connections and
    // delivering nothing. The script watches the pod it is attached to and restarts itself when
    // that pod stops being ready.
    const relay = exposeHorizonCommand(this.cfg);
    return this.procs.start({
      id: 'port-forward',
      label: 'Horizon relay ' + port,
      source: 'port-forward',
      cmd: relay.cmd,
      args: relay.args,
    });
  }

  stopPortForward() {
    return this.procs.stop('port-forward');
  }

  // --- build targets (dev-projects.yaml) -----------------------------------
  //
  // The repository's dev-projects.yaml lists the images that can be built locally. Building one
  // compiles it inside minikube's docker and repoints its Deployment at it. Nothing goes through
  // git, and the Applications' ignoreDifferences keep selfHeal from undoing the patch.
  //
  // Read by a small line parser rather than a YAML dependency: only the list of targets is
  // needed, and the repository's own scripts read the file the same way.

  readBuildTargets() {
    const file = path.join(this.cfg.paths.kubernetesRepo || '', 'dev-projects.yaml');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return { ok: false, detail: 'dev-projects.yaml: ' + e.message, targets: [] };
    }

    const targets = [];
    let cur = null;
    let inProjects = false;
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '');
      if (/^projects:\s*$/.test(line)) { inProjects = true; continue; }
      if (!inProjects) continue;
      if (/^[a-zA-Z]/.test(line)) break;            // back to root level: the list is over

      const started = line.match(/^\s*-\s*name:\s*(\S+)/);
      if (started) {
        cur = { name: started[1], path: '', deployment: '', initContainer: '' };
        targets.push(cur);
        continue;
      }
      if (!cur) continue;
      const kv = line.match(/^\s+(path|deployment|initContainer|image):\s*(\S+)/);
      if (kv) cur[kv[1]] = kv[2];
    }

    const nsMatch = raw.match(/^namespace:\s*(\S+)/m);
    const tagMatch = raw.match(/^tag:\s*(\S+)/m);
    return {
      ok: true,
      namespace: nsMatch ? nsMatch[1] : this.ns,
      tag: tagMatch ? tagMatch[1] : 'dev',
      targets,
    };
  }

  /**
   * Build one target. Long (the game server's export and publish take minutes), so it runs as a
   * tracked process with its own log tab rather than a blocking call -- otherwise the panel would
   * look frozen.
   */
  buildImage(target) {
    const known = this.readBuildTargets();
    if (!known.ok) return { ok: false, detail: known.detail };
    if (!known.targets.some((t) => t.name === target)) {
      return { ok: false, detail: 'unknown target: ' + target };
    }
    const { cmd, args } = buildAndDeployCommand(this.cfg, target);
    this.procs.start({
      id: 'build-' + target,
      label: 'Build ' + target,
      source: 'build',
      cmd,
      args,
      cwd: this.cfg.paths.kubernetesRepo,
    });
    return { ok: true, detail: 'build of ' + target + ' started (tab "build")' };
  }

  /**
   * Which sets of services the cluster runs: one `root-<set>` Application per deployed set (see
   * "Service sets" in the repository's README). Cached a few seconds: the probes ask often.
   * Returns { ok, sets: [{ id, deployed, health }] }.
   */
  async setsState() {
    if (this._sets && Date.now() - this._sets.at < 5000) return this._sets.value;
    const r = await run('kubectl', ['get', 'applications.argoproj.io', '-n', 'argocd', '--no-headers',
      '-o', 'custom-columns=NAME:.metadata.name,HEALTH:.status.health.status'], { timeoutMs: 8000 });
    let value;
    if (r.code !== 0) {
      value = { ok: false, sets: [], detail: (r.stderr || '').trim().split('\n')[0] };
    } else {
      const roots = new Map();
      for (const line of r.stdout.split(/\r?\n/)) {
        const [name, health] = line.trim().split(/\s+/);
        if (name && name.startsWith('root-')) roots.set(name.slice(5), health || '');
      }
      value = { ok: true, sets: SET_IDS.map((id) => ({ id, deployed: roots.has(id), health: roots.get(id) || '' })) };
    }
    this._sets = { at: Date.now(), value };
    return value;
  }

  /** Add or remove a set of services: the repository's sets-dev script, as a tracked process. */
  changeSet(action, set) {
    if (!SET_IDS.includes(set)) return { ok: false, detail: 'unknown set: ' + set };
    if (action === 'remove' && set === 'core') return { ok: false, detail: 'core cannot be removed' };
    this._sets = null;
    const { cmd, args } = setsCommand(this.cfg, [action, set]);
    this.procs.start({
      id: 'set-' + action + '-' + set, label: 'sets ' + action + ' ' + set, source: 'stack',
      cmd, args, cwd: this.cfg.paths.kubernetesRepo,
    });
    return { ok: true, detail: action + ' ' + set + ' started (tab "stack")' };
  }
}

module.exports = { K8s };
