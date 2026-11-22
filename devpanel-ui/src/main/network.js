'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./util');
const { t } = require('./i18n');

/**
 * Reaching the cluster from this machine without `minikube tunnel`.
 *
 * The repository's way is the tunnel: an elevated console that must stay open, and the hosts file
 * pointing the *.dyingstar.local names at Traefik's LoadBalancer address. It works, and it stays
 * available (the `network.mode` setting).
 *
 * The other way, this module's, needs elevated rights exactly ONCE:
 *
 *   - the hosts file points the names at 127.0.0.1 -- written once, it never changes again,
 *     whatever happens to the cluster;
 *   - three small relay containers, on minikube's own Docker network, forward loopback ports to
 *     the node:
 *         127.0.0.1:80         -> Traefik's HTTP NodePort
 *         127.0.0.1:443        -> Traefik's HTTPS NodePort
 *         127.0.0.1:<p>/udp    -> horizon's WebTransport NodePort
 *     They restart with Docker, so there is nothing to keep open.
 *
 * Two traps the relays are built around:
 *   - each gets a FIXED address at the top of the network's range. Docker restarts them BEFORE
 *     minikube, and a relay without a fixed address takes the first free one -- the node's own --
 *     after which `minikube start` fails with "address already in use";
 *   - the NodePorts are READ, never assumed: Traefik's are allocated when it is installed and
 *     differ from one machine to the next. A recreated cluster means recreated relays.
 *
 * The two ways cannot run together: both want port 80.
 */
const IMAGE = 'alpine/socat:1.8.0.3';
const DOCKER_NETWORK = 'minikube';
const LOOPBACK = '127.0.0.1';

/** "192.168.49.0/24" -> the three addresses kept for the relays, at the top of the range. */
function relayAddresses(subnet) {
  const m = String(subnet || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return null;
  const bits = Number(m[5]);
  if (bits < 16 || bits > 28) return null;
  const base = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  const broadcast = (base | ((1 << (32 - bits)) - 1)) >>> 0;
  const dotted = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  return { udp: dotted(broadcast - 5), http: dotted(broadcast - 4), https: dotted(broadcast - 3) };
}

/**
 * The relays this cluster needs. A relay whose port could not be read is left out, so a cluster
 * with no WebTransport port simply has no such relay.
 *
 * @param {object} facts { subnet, nodeIp, httpNodePort, httpsNodePort, udpNodePort }
 */
function buildRelaySpecs(facts) {
  const ips = relayAddresses(facts.subnet);
  if (!ips || !facts.nodeIp) return [];
  const specs = [];
  const tcp = (name, ip, port, nodePort) => specs.push({
    name, ip, image: IMAGE,
    bind: { container: port + '/tcp', hostPort: String(port) },
    cmd: ['TCP-LISTEN:' + port + ',fork,reuseaddr', 'TCP:' + facts.nodeIp + ':' + nodePort],
  });
  if (facts.httpNodePort) tcp('traefik-http-relay', ips.http, 80, facts.httpNodePort);
  if (facts.httpsNodePort) tcp('traefik-https-relay', ips.https, 443, facts.httpsNodePort);
  if (facts.udpNodePort) {
    const p = facts.udpNodePort;
    specs.push({
      name: 'horizon-wt-relay', ip: ips.udp, image: IMAGE,
      bind: { container: p + '/udp', hostPort: String(p) },
      cmd: ['-d', 'UDP4-LISTEN:' + p + ',fork,reuseaddr', 'UDP4:' + facts.nodeIp + ':' + p],
    });
  }
  return specs;
}

/** The `docker run` arguments that create a relay. Bound to loopback only, always. */
function dockerRunArgs(spec) {
  return [
    'run', '-d', '--name', spec.name, '--restart', 'unless-stopped',
    '--network', DOCKER_NETWORK, '--ip', spec.ip,
    '-p', LOOPBACK + ':' + spec.bind.hostPort + ':' + spec.bind.container,
    spec.image, ...spec.cmd,
  ];
}

/**
 * What to do about one relay, given what `docker inspect` says of the container of that name
 * (null when there is none): 'keep', 'start', 'create' or 'recreate'.
 *
 * Compared field by field, so a relay made by hand the same way is adopted as it is, and one that
 * points at a node or a port that no longer exists is replaced.
 */
function diffRelay(inspect, spec) {
  if (!inspect) return 'create';
  const cfg = inspect.Config || {};
  const host = inspect.HostConfig || {};
  const net = ((inspect.NetworkSettings || {}).Networks || {})[DOCKER_NETWORK] || null;
  const binding = ((host.PortBindings || {})[spec.bind.container] || [])[0] || null;
  const same = cfg.Image === spec.image
    && JSON.stringify(cfg.Cmd || []) === JSON.stringify(spec.cmd)
    && !!net && ((net.IPAMConfig || {}).IPv4Address === spec.ip)
    && !!binding && binding.HostIp === LOOPBACK && binding.HostPort === spec.bind.hostPort
    && Object.keys(host.PortBindings || {}).length === 1;
  if (!same) return 'recreate';
  return (inspect.State || {}).Running ? 'keep' : 'start';
}

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

  mode() {
    return (this.cfg.network && this.cfg.network.mode) === 'tunnel' ? 'tunnel' : 'relays';
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

  hostsState() {
    const names = this.hostNames();
    let text = '';
    try { text = fs.readFileSync(hostsFilePath(), 'utf8'); } catch { /* unreadable: every name is missing */ }
    return { names, missing: planHosts(text, names, LOOPBACK).missing };
  }

  /** What the cluster looks like from Docker and kubectl; null fields when it cannot be read. */
  async facts() {
    const ns = this.cfg.k8s.namespace;
    const [subnet, nodeIp, traefik, horizon] = await Promise.all([
      run('docker', ['network', 'inspect', DOCKER_NETWORK, '--format', '{{range .IPAM.Config}}{{.Subnet}}{{end}}'], { timeoutMs: 12000 }),
      run('minikube', ['ip'], { timeoutMs: 15000 }),
      run('kubectl', ['get', 'service', 'traefik', '-n', 'traefik', '-o', 'json'], { timeoutMs: 12000 }),
      run('kubectl', ['get', 'service', this.cfg.k8s.horizonDeployment || 'horizon', '-n', ns, '-o', 'json'], { timeoutMs: 12000 }),
    ]);
    const ports = (r) => { try { return JSON.parse(r.stdout).spec.ports || []; } catch { return []; } };
    const nodePort = (list, match) => (list.find(match) || {}).nodePort || null;
    return {
      subnet: subnet.code === 0 ? subnet.stdout.trim() : '',
      nodeIp: nodeIp.code === 0 ? nodeIp.stdout.trim() : '',
      httpNodePort: nodePort(ports(traefik), (p) => p.port === 80),
      httpsNodePort: nodePort(ports(traefik), (p) => p.port === 443),
      udpNodePort: nodePort(ports(horizon), (p) => (p.protocol || 'TCP') === 'UDP'),
    };
  }

  async _inspect(name) {
    const r = await run('docker', ['inspect', name], { timeoutMs: 12000 });
    if (r.code !== 0) return null;
    try { return JSON.parse(r.stdout)[0] || null; } catch { return null; }
  }

  /** For the status light and the card: the relays, the hosts file, and one line that sums it up. */
  async status() {
    const mode = this.mode();
    const hosts = this.hostsState();
    if (mode === 'tunnel') {
      return { mode, ok: hosts.missing.length === hosts.names.length ? false : true, hosts, relays: [], detail: t('net.tunnelMode') };
    }
    const specs = buildRelaySpecs(await this.facts());
    const relays = [];
    for (const spec of specs) relays.push({ name: spec.name, action: diffRelay(await this._inspect(spec.name), spec) });
    const relaysOk = specs.length > 0 && relays.every((r) => r.action === 'keep');
    const hostsOk = hosts.names.length > 0 && hosts.missing.length === 0;
    let detail = t('net.ok', { n: relays.length });
    if (!specs.length) detail = t('net.noCluster');
    else if (!relaysOk) detail = t('net.relaysOff', { names: relays.filter((r) => r.action !== 'keep').map((r) => r.name).join(', ') });
    else if (!hostsOk) detail = t('net.hostsMissing', { n: hosts.missing.length });
    return { mode, ok: relaysOk && hostsOk, relaysOk, hostsOk, hosts, relays, detail,
      hostsCommand: hostsOk ? '' : hostsCommand(hosts.missing, LOOPBACK) };
  }

  /**
   * Create, start or replace the relays so they match the cluster as it is now.
   * Returns { ok, done: [{ name, action }], detail }.
   */
  async ensureRelays() {
    if (this.mode() !== 'relays') return { ok: true, done: [], detail: 'tunnel mode: no relay' };
    const specs = buildRelaySpecs(await this.facts());
    if (!specs.length) return { ok: false, done: [], detail: 'the cluster cannot be read: is minikube running?' };
    const done = [];
    for (const spec of specs) {
      const action = diffRelay(await this._inspect(spec.name), spec);
      if (action === 'keep') continue;
      let r = { code: 0, stderr: '' };
      if (action === 'start') {
        r = await run('docker', ['start', spec.name], { timeoutMs: 30000 });
      } else {
        if (action === 'recreate') await run('docker', ['rm', '-f', spec.name], { timeoutMs: 30000 });
        r = await run('docker', dockerRunArgs(spec), { timeoutMs: 120000 });
      }
      if (r.code !== 0) {
        const why = (r.stderr || r.stdout || '').trim().split(/\r?\n/).pop();
        this.log.note('Network: relay ' + spec.name + ' could not be ' + action + 'd: ' + why, 'ERROR');
        return { ok: false, done, detail: spec.name + ': ' + why };
      }
      this.log.note('Network: relay ' + spec.name + ' ' + action + 'd (' + spec.cmd[spec.cmd.length - 1] + ').');
      done.push({ name: spec.name, action });
    }
    return { ok: true, done, detail: done.length ? done.map((d) => d.name + ' ' + d.action + 'd').join(', ') : 'nothing to do' };
  }

  /**
   * Point the stack's names at 127.0.0.1 in the hosts file. The ONE thing that needs elevated
   * rights: it is run through the system's own prompt, as a tracked process, and does nothing
   * when the file is already right.
   */
  writeHosts() {
    const { names, missing } = this.hostsState();
    if (!names.length) return { ok: false, detail: 'hosts_config.txt not found in the kubernetes repository' };
    if (!missing.length) return { ok: true, detail: 'the hosts file is already right' };
    if (process.platform === 'win32') {
      const script = path.join(this.scriptsDir, 'setup-hosts.ps1');
      const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Ip', LOOPBACK, '-Names', names.join(',')]
        .map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(',');
      this.procs.start({
        id: 'network-hosts', label: 'hosts file', source: 'network', cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process powershell -Verb RunAs -Wait -ArgumentList ' + inner],
      });
    } else {
      // Inline: root may not be able to read a script inside a mounted application image.
      const body = hostsBody(names, LOOPBACK);
      this.procs.start({ id: 'network-hosts', label: 'hosts file', source: 'network', cmd: 'pkexec', args: ['sh', '-c', body] });
    }
    return { ok: true, detail: 'asking for permission to write ' + missing.length + ' name(s): see the "network" tab' };
  }
}

module.exports = {
  Network, IMAGE, relayAddresses, buildRelaySpecs, dockerRunArgs, diffRelay, planHosts, isHostName, hostsFilePath, hostsBody, hostsCommand,
};
