'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { killTree } = require('./platform');
const { redactArgs } = require('./util');

/**
 * Owns every long-running child process the panel starts.
 *
 * One entry per logical process ("stack", "godot-server", "godot-client-1"...), so the
 * UI can show a status and a Stop button for each, and so shutting the panel down
 * can reliably take the whole stack with it.
 */
class ProcManager extends EventEmitter {
  constructor(logBus, { clearLogsOnRestart = true } = {}) {
    super();
    this.log = logBus;
    this.clearLogsOnRestart = clearLogsOnRestart;
    this.procs = new Map(); // id -> { id, label, child, pid, status, startedAt, exitCode, source }
  }

  isRunning(id) {
    const p = this.procs.get(id);
    return !!(p && p.status === 'running');
  }

  get(id) {
    return this.procs.get(id) || null;
  }

  /**
   * Start a child process and pipe its output into the log bus.
   *
   * @param {object} spec
   * @param {string} spec.id       stable identifier ("godot-server")
   * @param {string} spec.label    human label shown in the UI
   * @param {string} spec.cmd      executable
   * @param {string[]} spec.args
   * @param {string} spec.source   log source name (defaults to id)
   */
  start(spec) {
    const { id, label, cmd, args = [], cwd, env, source } = spec;

    if (this.isRunning(id)) {
      this.log.note('"' + label + '" is already running (PID ' + this.procs.get(id).pid + ').', 'WARN');
      return this.procs.get(id);
    }

    const logSource = source || id;

    /* Relaunching a process wipes what its previous run left behind, so a tab shows
     * exactly one run. Without this, restarting a client stacks two sessions in the
     * same tab and every search returns hits from a run you stopped caring about.
     * The .log files keep everything; only the live view is reset. */
    if (this.clearLogsOnRestart) {
      const owned = new Set([logSource, ...this.log.sourcesOwnedBy(id)]);
      const stale = [...owned].filter((n) => this.log.sources.has(n));
      if (stale.length) {
        this.log.clear(stale);
        this.log.note('Previous log cleared for: ' + stale.join(', ') + '.');
      }
    }

    const record = {
      id,
      label,
      source: logSource,
      status: 'starting',
      pid: null,
      startedAt: Date.now(),
      exitCode: null,
      cmd,
      args,
    };
    this.procs.set(id, record);
    this._emit();

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      record.status = 'error';
      record.error = String(err && err.message);
      this.log.note('Could not start "' + label + '": ' + record.error, 'ERROR');
      this._emit();
      return record;
    }

    record.child = child;
    record.pid = child.pid;
    record.status = 'running';
    // The command line is worth logging (it is what to copy to reproduce a launch), its secrets
    // are not: a client's --token= would otherwise sit in the log files for good.
    this.log.note('Started "' + label + '" (PID ' + child.pid + '): ' + cmd + ' ' + redactArgs(args).join(' '));
    this._emit();

    // Partial-line carries: a chunk boundary can fall mid-line, and stdout/stderr
    // are independent streams so each needs its own carry.
    const outCarry = { value: '' };
    const errCarry = { value: '' };

    const ingest = (chunk, carry) => this.log.writeChunk(logSource, chunk, carry, { owner: id });

    child.stdout.on('data', (c) => ingest(c, outCarry));
    child.stderr.on('data', (c) => ingest(c, errCarry));

    child.on('error', (err) => {
      record.status = 'error';
      record.error = String(err && err.message);
      this.log.note('Error on "' + label + '": ' + record.error, 'ERROR');
      this._emit();
    });

    child.on('close', (code, signal) => {
      // Flush whatever was left in the carries before declaring the process dead.
      if (outCarry.value) this.log.line(logSource, outCarry.value, { owner: id });
      if (errCarry.value) this.log.line(logSource, errCarry.value, { owner: id });

      record.exitCode = code;
      record.status = record.stopRequested ? 'stopped' : (code === 0 ? 'stopped' : 'crashed');
      record.child = null;
      const how = signal ? 'signal ' + signal : 'code ' + code;
      this.log.note(
        '"' + label + '" ended (' + how + ').',
        record.status === 'crashed' ? 'ERROR' : 'INFO'
      );
      this.emit('exit', record);
      this._emit();
    });

    return record;
  }

  /** Stop one process and its whole tree. */
  async stop(id) {
    const p = this.procs.get(id);
    if (!p || p.status !== 'running' || !p.pid) return false;
    p.stopRequested = true;
    p.status = 'stopping';
    this._emit();
    this.log.note('Stopping "' + p.label + '" (PID ' + p.pid + ', whole process tree)...');
    await killTree(p.pid);
    return true;
  }

  /** Stop everything, most recently started first. */
  async stopAll() {
    const ids = [...this.procs.keys()].reverse();
    for (const id of ids) {
      if (this.isRunning(id)) await this.stop(id);
    }
  }

  snapshot() {
    return [...this.procs.values()].map((p) => ({
      id: p.id,
      label: p.label,
      source: p.source,
      status: p.status,
      pid: p.pid,
      startedAt: p.startedAt,
      exitCode: p.exitCode,
      error: p.error || null,
    }));
  }

  _emit() {
    this.emit('change', this.snapshot());
  }
}

module.exports = { ProcManager };
