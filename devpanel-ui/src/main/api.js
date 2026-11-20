'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Small local HTTP API so a script (or an assistant) can read the live state and search the
 * logs without scrolling a terminal or swallowing a 500 MB file.
 *
 * Security posture, deliberately chosen for a dev machine:
 *   - binds 127.0.0.1 only, never a routable interface, and this is not a setting;
 *   - refuses any request whose Host header is not this machine: a web page open in a browser
 *     cannot then reach the API by pointing a name of its own at 127.0.0.1 (DNS rebinding);
 *   - GET endpoints (read-only: state, logs, search) need no token;
 *   - POST /api/action can restart pods and truncate a database, so it requires the token
 *     written to <data dir>/runtime/api-token.txt at startup, readable by its owner only.
 */
const HOST = '127.0.0.1';

/** Is this Host header one of the names of the local machine? (with or without a port) */
function isLoopbackHost(header) {
  const host = String(header || '').toLowerCase().replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

class Api {
  constructor({ config, runtimeDir, logBus, getState, doAction }) {
    this.cfg = config;
    this.logBus = logBus;
    this.getState = getState;
    this.doAction = doAction;
    this.runtimeDir = runtimeDir;
    this.server = null;
    this.token = crypto.randomBytes(16).toString('hex');
    this.port = null;
  }

  start() {
    if (!this.cfg.api.enabled) return;

    const host = HOST;
    const port = this.cfg.ports.api;

    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', (err) => {
      this.logBus.note('Local API unavailable: ' + String(err && err.message), 'WARN');
    });

    this.server.listen(port, host, () => {
      this.port = port;
      const secret = { encoding: 'utf8', mode: 0o600 };
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(this.runtimeDir, 'api-token.txt'), this.token, secret);
      fs.writeFileSync(
        path.join(this.runtimeDir, 'api.json'),
        JSON.stringify({ url: 'http://' + host + ':' + port, token: this.token, pid: process.pid }, null, 2),
        secret
      );
      this.logBus.note('Local API on http://' + host + ':' + port + ' (reading is open, actions need the token).');
    });
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
    }
  }

  _json(res, code, body) {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }

  async _handle(req, res) {
    if (!isLoopbackHost(req.headers.host)) {
      return this._json(res, 403, { error: 'this API only answers to requests addressed to this machine' });
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return this._json(res, 400, { error: 'invalid url' });
    }
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;

    try {
      if (req.method === 'GET' && (p === '/' || p === '/api')) {
        return this._json(res, 200, {
          name: 'ds-devpanel',
          endpoints: [
            'GET  /api/state',
            'GET  /api/sources',
            'GET  /api/logs?source=&q=&regex=0&case=0&level=&limit=200&sinceSeq=',
            'GET  /api/tail?source=&n=100',
            'POST /api/action   { "action": "...", ... }  header: x-devpanel-token',
          ],
          actions: [
            'start-all', 'stop-all', 'abort',
            'start-docker', 'start-minikube', 'start-stack', 'stop-stack',
            'delete-cluster {confirm: true}',
            'start-godot-server', 'stop-godot-server', 'start-editor', 'stop-editor',
            'start-clients {count}', 'stop-clients',
            'relink-now', 'relink-watch {on}',
            'restart-deployment {name}', 'delete-pod {name}',
            'purge-scylla', 'port-forward {on}', 'read-build-targets', 'build-image {target}',
            'kill-orphan-godot', 'use-minikube-context', 'restart-npc',
            'telepresence-connect', 'telepresence-intercept', 'telepresence-leave', 'telepresence-quit',
            'network-repair', 'network-hosts',
            'clear-logs {source}', 'stop-proc {id}',
          ],
        });
      }

      if (req.method === 'GET' && p === '/api/state') {
        return this._json(res, 200, await this.getState());
      }

      if (req.method === 'GET' && p === '/api/sources') {
        return this._json(res, 200, { sources: this.logBus.sourceList() });
      }

      if (req.method === 'GET' && p === '/api/logs') {
        const result = this.logBus.search({
          source: q.get('source') || undefined,
          q: q.get('q') || undefined,
          regex: q.get('regex') === '1' || q.get('regex') === 'true',
          caseSensitive: q.get('case') === '1' || q.get('case') === 'true',
          level: q.get('level') || undefined,
          limit: q.has('limit') ? Number(q.get('limit')) : 200,
          sinceSeq: q.has('sinceSeq') ? Number(q.get('sinceSeq')) : undefined,
        });
        return this._json(res, result.error ? 400 : 200, result);
      }

      if (req.method === 'GET' && p === '/api/tail') {
        const n = q.has('n') ? Number(q.get('n')) : 100;
        const result = this.logBus.search({ source: q.get('source') || undefined, limit: n });
        return this._json(res, 200, result);
      }

      if (req.method === 'POST' && p === '/api/action') {
        const token = req.headers['x-devpanel-token'];
        if (token !== this.token) {
          return this._json(res, 401, {
            error: 'missing or invalid token (read it from runtime/api-token.txt in the data directory)',
            tokenFile: path.join(this.runtimeDir, 'api-token.txt'),
          });
        }
        const body = await this._readBody(req);
        if (!body || !body.action) return this._json(res, 400, { error: 'field "action" is required' });
        const result = await this.doAction(body.action, body);
        return this._json(res, result && result.ok === false ? 400 : 200, result || { ok: true });
      }

      return this._json(res, 404, { error: 'unknown route: ' + p });
    } catch (err) {
      return this._json(res, 500, { error: String(err && err.message) });
    }
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        if (!data.trim()) return resolve({});
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }
}

module.exports = { Api, isLoopbackHost };
