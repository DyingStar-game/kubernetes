'use strict';

const { spawn } = require('node:child_process');

/**
 * Per-pod log streaming.
 *
 * ArgoCD hands the panel no log stream at all: it reconciles the cluster and walks away.
 * So the panel follows the pods itself, with one "kubectl logs -f" per pod, merged into
 * the same bus as every other source -- which is what gives each service its tab, its
 * level chips and the live search.
 *
 * Three things this has to get right, and none of them is optional:
 *
 *  - **A pod is replaced constantly.** Every build, every relink, every ArgoCD sync
 *    creates a new pod and the old stream dies with it. So the pod list is re-read on a
 *    timer and any pod without a stream gets one. Attaching once at startup would go
 *    quiet after the first relink -- silently, which is the worst kind of quiet.
 *
 *  - **The tab must be named after the SERVICE, not the pod.** A pod name carries a
 *    generated suffix that changes on every restart; naming tabs after it would spawn a
 *    fresh tab each time and scatter the history across a dozen of them.
 *
 *  - **Only pods that are actually Running.** "kubectl logs" fails on a pod still in
 *    Init, and retrying it every few seconds would fill the panel with its own errors.
 */
class PodLogs {
  constructor({ config, log }) {
    this.cfg = config;
    this.log = log;
    this.ns = config.k8s.namespace;
    this.streams = new Map();   // pod name -> { child, source }
    this.timer = null;
    this.running = false;
    this.pollMs = 8000;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log.note('Following the pod logs (namespace ' + this.ns + ').');
    this._tick();
    this.timer = setInterval(() => this._tick(), this.pollMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [, s] of this.streams) {
      try { s.child.kill(); } catch { /* already gone */ }
    }
    this.streams.clear();
  }

  status() {
    return {
      running: this.running,
      namespace: this.ns,
      streams: [...this.streams.entries()].map(([pod, s]) => ({ pod, source: s.source })),
    };
  }

  /**
   * Tab name for a pod -- derived from its NAME, not from its labels.
   *
   * Measured, because the obvious choice is wrong here: "app.kubernetes.io/name" is the
   * CHART name, so livekit and livekit-redis both carry "livekit", and scylladb carries
   * "service-persistence". Trusting that label merged a database's log into its
   * service's tab. The pod name distinguishes them exactly.
   *
   * The generated suffix is stripped in exactly ONE pass, never two: a second pass on a
   * five-character tail also eats real words of five letters, and turned "livekit-redis"
   * into "livekit".
   */
  _sourceFor(item) {
    const name = String(item.metadata.name);
    const rs = name.replace(/-[a-z0-9]{6,12}-[a-z0-9]{5}$/, '');   // Deployment -> ReplicaSet -> pod
    if (rs !== name) return rs;
    const ds = name.replace(/-[a-z0-9]{5}$/, '');                  // DaemonSet
    if (ds !== name) return ds;
    const ss = name.replace(/-\d+$/, '');                          // StatefulSet
    if (ss !== name) return ss;
    const labels = (item.metadata && item.metadata.labels) || {};
    return String(labels['app.kubernetes.io/name'] || labels.app || name);
  }

  async _tick() {
    if (!this.running) return;

    const list = await this._listPods();
    if (list == null) return;   // cluster unreachable: stay quiet, try again next tick

    const alive = new Set(list.map((p) => p.name));
    for (const [pod, s] of this.streams) {
      if (!alive.has(pod)) {
        try { s.child.kill(); } catch { /* already gone */ }
        this.streams.delete(pod);
      }
    }

    for (const p of list) {
      if (p.phase !== 'Running') continue;
      if (this.streams.has(p.name)) continue;
      this._attach(p);
    }
  }

  _listPods() {
    return new Promise((resolve) => {
      const child = spawn('kubectl', ['get', 'pods', '-n', this.ns, '-o', 'json'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code !== 0) return resolve(null);
        try {
          const j = JSON.parse(out);
          resolve((j.items || []).map((item) => ({
            name: item.metadata.name,
            phase: item.status && item.status.phase,
            source: this._sourceFor(item),
          })));
        } catch { resolve(null); }
      });
    });
  }

  _attach(p) {
    // --max-log-requests, otherwise horizon NEVER starts streaming: it has six init
    // containers plus the main one, so seven streams, and kubectl refuses more than five
    // by default ("maximum allowed concurrency is 5"). The failure was silent -- the
    // stream closed at once and the horizon tab simply stayed empty.
    const child = spawn(
      'kubectl',
      ['logs', '-f', '--tail=200', '--all-containers=true', '--max-log-requests=20',
       p.name, '-n', this.ns],
      { windowsHide: true }
    );

    this.streams.set(p.name, { child, source: p.source });

    // kubectl emits whole lines, but a chunk can split one, so keep the remainder.
    let buf = '';
    const feed = (chunk) => {
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const lineText of parts) {
        if (lineText.trim()) this.log.line(p.source, lineText, { owner: 'pod-logs' });
      }
    };

    child.stdout.on('data', (d) => feed(String(d)));
    child.stderr.on('data', (d) => feed(String(d)));
    child.on('error', () => { this.streams.delete(p.name); });
    child.on('close', () => {
      if (buf.trim()) this.log.line(p.source, buf, { owner: 'pod-logs' });
      // Deleted rather than kept as a tombstone: if the pod is still alive the next tick
      // re-attaches, which is exactly what should happen after a dropped connection.
      this.streams.delete(p.name);
    });
  }
}

module.exports = { PodLogs };
