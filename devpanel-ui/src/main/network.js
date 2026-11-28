'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./util');
const { t } = require('./i18n');

/**
 * Reaching the cluster from this machine.
 *
 * k3d publishes the cluster's ports on the loopback address when it is created (start-dev):
 *
 *         127.0.0.1:80         -> Traefik (HTTP)
 *         127.0.0.1:443        -> Traefik (HTTPS)
 *         127.0.0.1:8443       -> Traefik (telepresence entry point)
 *         127.0.0.1:30101/udp  -> horizon's WebTransport NodePort
 *
 * So there is nothing to relay and no tunnel to keep open. What remains is the hosts file: the
 * *.dyingstar.local names must point at 127.0.0.1 -- written once (it needs elevated rights),
 * it never changes again, whatever happens to the cluster.
 */
const LOOPBACK = '127.0.0.1';
/** The ports k3d must publish on the host (see start-dev). */
const PUBLISHED_PORTS = ['80/tcp', '443/tcp', '8443/tcp', '30101/udp'];

/**
 * Read a hosts file against the names the stack needs.
 * Returns { missing: [names not pointing at ip], text: the file as it should be }.
 * A line that gives one of the names another address is dropped; everything else is kept.
 */
function planHosts(text, names, ip) {
  const eol = String(text || '').includes('\r\n') ? '\r\n' : '\n';
  const wanted = new Set(names);
  const pointed = new Set();
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const body = line.replace(/#.*$/, '').trim();
    if (!body) { kept.push(line); continue; }
    const parts = body.split(/\s+/);
    const lineNames = parts.slice(1);
    const ours = lineNames.filter((n) => wanted.has(n));
    if (!ours.length) { kept.push(line); continue; }
    if (parts[0] === ip && ours.length === lineNames.length) {
      ours.forEach((n) => pointed.add(n));
      kept.push(line);
    }
    // Otherwise the line maps one of our names elsewhere (or mixes it with others): it goes,
    // and the name is written again below.
  }
  const missing = names.filter((n) => !pointed.has(n));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const lines = [...kept, ...missing.map((n) => ip + ' ' + n)];
  return { missing, text: lines.join(eol) + eol };
}

/**
 * The shell that points names at the loopback address in /etc/hosts (idempotent: a name's old line
 * goes first). Run by pkexec from the panel, or pasted by the user after `sudo`.
 */
function hostsBody(names, ip) {
  return names.map((n) => "sed -i '/[[:space:]]" + n.replace(/\./g, '\\.') + "$/d' /etc/hosts && echo '"
    + ip + ' ' + n + "' >> /etc/hosts").join(' && ');
}

/**
 * The same thing as one line to paste in a terminal, for a machine where the system's graphical
 * prompt (pkexec) is not there or not wanted. '' where it makes no sense (Windows has its own prompt).
 */
function hostsCommand(names, ip = '127.0.0.1', platform = process.platform) {
  if (platform === 'win32' || !names.length) return '';
  return 'sudo sh -c "' + hostsBody(names, ip).replace(/(["$`\\])/g, '\\$1') + '"';
}

/** Host names are written into a file by an elevated process: nothing but a plain name gets through. */
function isHostName(name) {
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(String(name));
}

function hostsFilePath(platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts';
}

class Network {
  constructor({ config, log, procs, scriptsDir }) {
    this.cfg = config;
    this.log = log;
    this.procs = procs;
    this.scriptsDir = scriptsDir;
  }

  /** The names the stack is served under, from the repository's own list. */
  hostNames() {
    try {
      return fs.readFileSync(path.join(this.cfg.paths.kubernetesRepo || '', 'hosts_config.txt'), 'utf8')
        .split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter((n) => n && isHostName(n));
    } catch {
      return [];
    }
  }

  hostsState(ip = LOOPBACK) {
    const names = this.hostNames();
    let text = '';
    try { text = fs.readFileSync(hostsFilePath(), 'utf8'); } catch { /* unreadable: every name is missing */ }
    return { names, ip, missing: ip ? planHosts(text, names, ip).missing : names };
  }

  /** The name of the cluster's load balancer container (k3d-<cluster>-serverlb). */
  lbContainer() {
    return 'k3d-' + ((this.cfg.k3d && this.cfg.k3d.cluster) || 'dyingstar') + '-serverlb';
  }

  /**
   * The published ports the load balancer is missing (empty when all are there), or null when it
   * cannot be read (no such container: the cluster does not exist or Docker is down).
   */
  async missingPorts() {
    const r = await run('docker', ['port', this.lbContainer()], { timeoutMs: 12000 });
    if (r.code !== 0) return null;
    // "80/tcp -> 0.0.0.0:80" lines; the container's side is what we compare.
    const have = new Set(r.stdout.split(/\r?\n/).map((l) => l.split(/\s+->/)[0].trim()).filter(Boolean));
    return PUBLISHED_PORTS.filter((p) => !have.has(p));
  }

  /** For the status light and the card: the published ports, the hosts file, and a one-line summary. */
  async status() {
    const hosts = this.hostsState();
    const missing = await this.missingPorts();
    const portsOk = missing !== null && missing.length === 0;
    const hostsOk = hosts.names.length > 0 && hosts.missing.length === 0;
    let detail = t('net.ok', { n: PUBLISHED_PORTS.length });
    if (missing === null) detail = t('net.noCluster');
    else if (!portsOk) detail = t('net.portsMissing', { ports: missing.join(', ') });
    else if (!hostsOk) detail = t('net.hostsMissing', { n: hosts.missing.length });
    return { ok: portsOk && hostsOk, portsOk, hostsOk, hosts, detail,
      hostsCommand: hostsOk ? '' : hostsCommand(hosts.missing, LOOPBACK) };
  }

  /**
   * Check that the cluster publishes the ports the stack needs. Nothing to repair from here: the
   * ports are fixed when the cluster is created, so a missing one means recreating it (start-dev
   * does it, on a cluster created without them).
   * Returns { ok, done, detail } (the shape the start chain already reads).
   */
  async ensurePorts() {
    const missing = await this.missingPorts();
    if (missing === null) return { ok: false, done: [], detail: 'the cluster cannot be read: is it running?' };
    if (missing.length) {
      return { ok: false, done: [], detail: 'the cluster does not publish ' + missing.join(', ')
        + ': delete it and run start-dev again so it is created with them' };
    }
    return { ok: true, done: [], detail: 'ports published' };
  }

  /**
   * Point the stack's names at 127.0.0.1 in the hosts file. The ONE thing that needs elevated
   * rights: it is run through the system's own prompt, as a tracked process, and does nothing
   * when the file is already right.
   */
  async writeHosts() {
    const ip = LOOPBACK;
    const { names, missing } = this.hostsState(ip);
    if (!names.length) return { ok: false, detail: 'hosts_config.txt not found in the kubernetes repository' };
    if (!missing.length) return { ok: true, detail: 'the hosts file is already right' };
    if (process.platform === 'win32') {
      const script = path.join(this.scriptsDir, 'setup-hosts.ps1');
      const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Ip', ip, '-Names', names.join(',')]
        .map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(',');
      this.procs.start({
        id: 'network-hosts', label: 'hosts file', source: 'network', cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process powershell -Verb RunAs -Wait -ArgumentList ' + inner],
      });
    } else {
      // Inline: root may not be able to read a script inside a mounted application image.
      const body = hostsBody(names, ip);
      this.procs.start({ id: 'network-hosts', label: 'hosts file', source: 'network', cmd: 'pkexec', args: ['sh', '-c', body] });
    }
    return { ok: true, detail: 'asking for permission to write ' + missing.length + ' name(s): see the "network" tab' };
  }
}

module.exports = {
  Network, PUBLISHED_PORTS, planHosts, isHostName, hostsFilePath, hostsBody, hostsCommand,
};
