'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');

// Matches every ANSI escape sequence (colours, cursor moves, OSC titles...).
// The services and Godot both emit them; we strip at ingest and re-colour ourselves,
// so the stored text is always plain -- which is what makes search reliable.
// Built from a string with explicit \u escapes so this source file stays ASCII.
const ANSI_RE = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*',
    '(?:',
    '(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)',
    '|',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])',
    ')',
  ].join(''),
  'g'
);

function stripAnsi(s) {
  // Also drop carriage returns: progress bars rewrite a line with \r and would
  // otherwise leave invisible junk inside a stored log entry.
  return String(s).replace(ANSI_RE, '').replace(/\r/g, '');
}

// --- secrets ------------------------------------------------------------------
//
// A token on a command line or in a child's output must never reach a log: the log files are
// read, searched, copied into bug reports and served by the local API.

// `--token=<value>`, `--password:<value>`... : the value is what gets hidden.
const SECRET_ARG_RE = /^(--?(?:token|password|passwd|secret|api[-_]?key)[=:])(.+)$/i;
// The same options when the value is the NEXT argument.
const SECRET_FLAG_RE = /^--?(?:token|password|passwd|secret|api[-_]?key)$/i;
// A JSON Web Token: three base64url parts, the first two being JSON objects ("eyJ" is `{"`).
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** A line of text with any JSON Web Token in it masked. Cheap when there is none. */
function redactText(text) {
  const s = String(text);
  return s.includes('eyJ') ? s.replace(JWT_RE, '<redacted token>') : s;
}

/** A command line's arguments, safe to print: secret values are masked, the rest is untouched. */
function redactArgs(args) {
  const out = [];
  let hideNext = false;
  for (const raw of args || []) {
    const arg = String(raw);
    if (hideNext) {
      out.push('<redacted>');
      hideNext = false;
    } else if (SECRET_FLAG_RE.test(arg)) {
      out.push(arg);
      hideNext = true;
    } else {
      out.push(redactText(arg.replace(SECRET_ARG_RE, (_m, flag) => flag + '<redacted>')));
    }
  }
  return out;
}

/**
 * Run a command to completion and capture its output.
 * Never rejects: callers inspect `code` instead of wrapping every call in try/catch.
 */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        ...opts,
        env: { ...process.env, ...(opts.env || {}) },
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message), failed: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code, extra = {}) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, failed: code !== 0, ...extra });
    };

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => finish(-1, { stderr: String(err && err.message) }));
    child.on('close', (code) => finish(code == null ? -1 : code));

    if (opts.timeoutMs) {
      const t = setTimeout(() => {
        if (settled) return;
        // Lazily required: the platform layer requires this module for `run`, so
        // importing it at the top would be a cycle. By the time a timeout fires,
        // every module is fully loaded.
        require('./platform').killTree(child.pid);
        finish(-1, { stderr: 'timeout', timedOut: true });
      }, opts.timeoutMs);
      if (t.unref) t.unref();
    }
  });
}

/** Resolve true once a TCP port accepts a connection (readiness probe). */
function tcpProbe(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Poll `check` until it returns truthy or the deadline passes. Resolves to the value, or null. */
async function waitFor(check, { timeoutMs = 60000, intervalMs = 1500, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal && signal.aborted) return null;
    let value = null;
    try {
      value = await check();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { stripAnsi, redactText, redactArgs, run, tcpProbe, waitFor, sleep };
