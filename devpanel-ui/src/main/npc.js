'use strict';

const { run } = require('./util');
const { t } = require('./i18n');

/**
 * The NPC service, as seen from the panel.
 *
 * ArgoCD deploys it in the cluster as the `service-npc` Deployment and keeps it up (selfHeal would
 * put back a scale to zero at once), so there is nothing to start or stop here. What is left is
 * what one actually needs while playing:
 *   - its state, read from the Deployment;
 *   - a restart, by deleting its pod (K8s.restartDeployment: one restart, nothing for selfHeal to undo);
 *   - its log, which needs nothing here: PodLogs follows every pod, so it has its own
 *     `service-npc` tab, searchable next to horizon's and the game server's.
 */
const DEPLOYMENT = 'service-npc';

class Npc {
  constructor({ config, log, k8s }) {
    this.cfg = config;
    this.log = log;
    this.k8s = k8s;
  }

  get _ns() {
    return this.cfg.k8s.namespace;
  }

  async restart() {
    return this.k8s.restartDeployment(DEPLOYMENT);
  }

  /** Ready or not, from the Deployment itself -- never from what we believe we started. */
  async probe() {
    const r = await run('kubectl', ['get', 'deployment', DEPLOYMENT, '-n', this._ns, '-o',
      'jsonpath={.status.readyReplicas}/{.spec.replicas}'], { timeoutMs: 12000 });
    if (r.code !== 0) {
      return { ok: false, detail: t('probe.deployMissing', { name: DEPLOYMENT, ns: this._ns }) };
    }
    const [ready, wanted] = (r.stdout || '').trim().split('/');
    const ok = Number(ready || 0) > 0 && Number(ready || 0) >= Number(wanted || 1);
    return { ok, detail: t('probe.deployReady', { name: DEPLOYMENT, ready: ready || '0', wanted: wanted || '?' }) };
  }
}

module.exports = { Npc };
