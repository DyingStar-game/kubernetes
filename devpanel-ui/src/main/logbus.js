'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { stripAnsi, redactText } = require('./util');

/** Log levels we recognise, most severe first (order matters for the UI filter). */
const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

/**
 * Guess a level from a raw line.
 * Rust services (horizon, persistence) print ` INFO `/` WARN ` as a standalone word;
 * Godot prints `ERROR:` / `WARNING:` / `SCRIPT ERROR:` at the start of a line.
 */
function detectLevel(text) {
  if (/^\s*(?:SCRIPT\s+)?ERROR:/.test(text)) return 'ERROR';
  if (/^\s*WARNING:/.test(text)) return 'WARN';
  if (/\bERROR\b/.test(text)) return 'ERROR';
  if (/\bWARN(?:ING)?\b/.test(text)) return 'WARN';
  if (/\bDEBUG\b/.test(text)) return 'DEBUG';
  if (/\bTRACE\b/.test(text)) return 'TRACE';
  if (/\bINFO\b/.test(text)) return 'INFO';
  return '';
}

/** Filesystem-safe name for a source (used for the .log filenames). */
function safeName(source) {
  return String(source).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Central log bus.
 *
 * Every line from every process lands here, gets a sequence number, a source and a
 * level, and is then:
 *   - appended to a per-source .log file on disk (so any tool can read it),
 *   - kept in a bounded in-memory ring buffer (so search is instant),
 *   - emitted to the UI in small batches (so a burst does not freeze the renderer).
 */
class LogBus extends EventEmitter {
  constructor({ logDir, maxLines = 120000 }) {
    super();
    this.logDir = logDir;
    this.maxLines = maxLines;

    this.entries = [];      // ring buffer of { i, t, src, lvl, text }
    this.seq = 0;
    this.sources = new Map(); // source -> { count, first, last }
    this.streams = new Map(); // source -> fs.WriteStream

    this._pending = [];
    this._flushTimer = null;

    this._rotate();
    this._allStream = this._streamFor('_all');
  }

  /** Move the previous session's logs aside so each run starts with clean files. */
  _rotate() {
    fs.mkdirSync(this.logDir, { recursive: true });
    const prevDir = path.join(this.logDir, 'previous');
    let existing = [];
    try {
      existing = fs.readdirSync(this.logDir).filter((f) => f.endsWith('.log'));
    } catch { existing = []; }
    if (!existing.length) return;

    fs.rmSync(prevDir, { recursive: true, force: true });
    fs.mkdirSync(prevDir, { recursive: true });
    for (const f of existing) {
      try {
        fs.renameSync(path.join(this.logDir, f), path.join(prevDir, f));
      } catch { /* file locked: leave it, we append anyway */ }
    }
  }

  _streamFor(source) {
    let s = this.streams.get(source);
    if (!s) {
      s = fs.createWriteStream(path.join(this.logDir, safeName(source) + '.log'), { flags: 'a' });
      s.on('error', () => { /* never let a log write crash the panel */ });
      this.streams.set(source, s);
    }
    return s;
  }

  /**
   * Ingest a raw chunk of process output.
   * Handles partial lines: a chunk may cut a line in half, so the tail is held in
   * `carry` (owned by the caller) until the rest arrives.
   */
  writeChunk(source, chunk, carry, opts) {
    const text = carry.value + chunk.toString('utf8');
    const lines = text.split('\n');
    carry.value = lines.pop() || '';
    for (const line of lines) this.line(source, line, opts);
  }

  /**
   * Ingest one line.
   * `owner` is the process id that produced it, so restarting that process can wipe
   * every source it fed.
   */
  line(source, rawLine, { owner = null } = {}) {
    // A child process can echo the token it was given: mask it here, before the line reaches
    // the buffer, the files or the API.
    const text = redactText(stripAnsi(rawLine));
    if (!text.trim()) return;

    const src = source;

    const entry = {
      i: this.seq++,
      t: Date.now(),
      src,
      lvl: detectLevel(text),
      text,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxLines) {
      this.entries.splice(0, this.entries.length - this.maxLines);
    }

    const meta = this.sources.get(src) || { count: 0, first: entry.t, last: entry.t, owner };
    meta.count += 1;
    meta.last = entry.t;
    if (owner && !meta.owner) meta.owner = owner;
    this.sources.set(src, meta);

    const stamp = new Date(entry.t).toISOString();
    this._streamFor(src).write(stamp + ' ' + text + '\n');
    this._allStream.write(stamp + ' [' + src + '] ' + text + '\n');

    this._pending.push(entry);
    if (!this._flushTimer) {
      // Batch UI updates: a busy stack emits thousands of lines a second and one IPC
      // message per line would stall the renderer. 120 ms keeps the log feeling live
      // while halving the number of structured-clone round trips.
      this._flushTimer = setTimeout(() => this._flush(), 120);
    }
  }

  _flush() {
    this._flushTimer = null;
    if (!this._pending.length) return;
    const batch = this._pending;
    this._pending = [];
    this.emit('lines', batch);
  }

  /** A panel-generated message (chain progress, errors, notes). */
  note(text, level = 'INFO') {
    this.line('panel', level === 'INFO' ? text : level + ' ' + text);
  }

  /**
   * Drop lines from memory. `names` = null clears everything.
   *
   * Deliberately does NOT truncate the .log files: it writes a separator instead.
   * The panel and the API then show only what came after the clear (which is the
   * point -- "keep just the last run"), while the file on disk keeps the full
   * history in case the previous run is exactly the one that crashed.
   */
  clear(names = null) {
    const all = names == null;
    const set = all ? new Set(this.sources.keys()) : new Set(names);
    if (!all && set.size === 0) return [];

    this.entries = all ? [] : this.entries.filter((e) => !set.has(e.src));
    this._pending = all ? [] : this._pending.filter((e) => !set.has(e.src));

    const stamp = new Date().toISOString();
    for (const name of set) {
      this.sources.delete(name);
      const stream = this.streams.get(name);
      if (stream) stream.write('----- cleared at ' + stamp + ' (new run) -----\n');
    }
    if (all && this._allStream) {
      this._allStream.write('----- cleared at ' + stamp + ' -----\n');
    }

    this.emit('cleared', { sources: [...set], all });
    return [...set];
  }

  /** Every source fed by a given process. */
  sourcesOwnedBy(ownerId) {
    const out = [];
    for (const [name, meta] of this.sources) {
      if (meta.owner === ownerId) out.push(name);
    }
    return out;
  }

  sourceList() {
    return [...this.sources.entries()]
      .map(([name, m]) => ({ name, count: m.count, first: m.first, last: m.last }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Search the in-memory buffer.
   * This is what the HTTP API exposes, so a script or an assistant can ask a precise question
   * ("last 200 horizon lines containing ERROR") instead of reading a 500 MB file.
   */
  search({ source, q, regex = false, caseSensitive = false, level, limit = 200, sinceSeq } = {}) {
    let matcher = null;
    if (q) {
      if (regex) {
        try {
          matcher = new RegExp(q, caseSensitive ? '' : 'i');
        } catch (err) {
          return { error: 'invalid regex: ' + err.message, lines: [], total: 0 };
        }
      } else {
        const needle = caseSensitive ? q : q.toLowerCase();
        matcher = { test: (s) => (caseSensitive ? s : s.toLowerCase()).includes(needle) };
      }
    }

    const wantSources = source && source !== '*'
      ? new Set(String(source).split(',').map((s) => s.trim()).filter(Boolean))
      : null;
    const wantLevels = level
      ? new Set(String(level).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
      : null;

    const hits = [];
    for (const e of this.entries) {
      if (sinceSeq != null && e.i <= sinceSeq) continue;
      if (wantSources && !wantSources.has(e.src)) continue;
      if (wantLevels && !wantLevels.has(e.lvl)) continue;
      if (matcher && !matcher.test(e.text)) continue;
      hits.push(e);
    }

    const total = hits.length;
    const lines = limit > 0 ? hits.slice(-limit) : hits;
    return { total, returned: lines.length, lines };
  }

  close() {
    this._flush();
    for (const s of this.streams.values()) {
      try { s.end(); } catch { /* ignore */ }
    }
  }
}

module.exports = { LogBus, LEVELS, detectLevel };
