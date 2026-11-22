'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Putting the environment right before anything is started.
 *
 * Two things go wrong once the panel is INSTALLED rather than run from a terminal, both on
 * Linux, both silent:
 *
 *   - Started from a desktop menu, a program does not get the PATH of your terminal: what your
 *     shell profile adds (~/.local/bin, a version manager, a tool installed by hand) is missing,
 *     and kubectl or minikube are "not found" although they work in every terminal you open.
 *     The cure is to ask the login shell for its PATH once, at start.
 *
 *   - An AppImage runs with variables pointing INSIDE its own mounted image (APPDIR, a library
 *     path...). A child process that inherits them -- Godot, docker -- may load the panel's
 *     libraries instead of its own. They are removed from what children inherit.
 */

/** PATH entries of `extra` that `current` lacks, appended in order. */
function mergePath(current, extra, delimiter = path.delimiter) {
  const have = String(current || '').split(delimiter).filter(Boolean);
  const seen = new Set(have);
  for (const dir of String(extra || '').split(delimiter)) {
    if (dir && !seen.has(dir)) {
      have.push(dir);
      seen.add(dir);
    }
  }
  return have.join(delimiter);
}

/** The PATH of the user's login shell, or null when it cannot be had quickly. */
function loginShellPath(env = process.env) {
  const shell = env.SHELL || '/bin/sh';
  const mark = '__DEVPANEL_PATH__';
  // -i and -l: profiles differ on which of the two they hang PATH changes on. The markers fence
  // off whatever a chatty profile prints around it.
  const r = spawnSync(shell, ['-ilc', 'printf "' + mark + '%s' + mark + '" "$PATH"'], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = String(r.stdout || '').match(new RegExp(mark + '(.*?)' + mark, 's'));
  return m && m[1] ? m[1] : null;
}

/**
 * Remove from `env` what only makes sense inside the AppImage. Returns the image's own path
 * (needed to relaunch the panel), or null when not running from an AppImage.
 */
function stripAppImage(env = process.env, delimiter = path.delimiter) {
  const image = env.APPIMAGE || null;
  const appDir = env.APPDIR || null;
  if (!image || !appDir) return image;
  for (const name of ['LD_LIBRARY_PATH', 'GSETTINGS_SCHEMA_DIR', 'XDG_DATA_DIRS', 'PATH']) {
    if (!env[name]) continue;
    const kept = env[name].split(delimiter).filter((dir) => dir && !dir.startsWith(appDir));
    if (kept.length) env[name] = kept.join(delimiter); else delete env[name];
  }
  for (const name of ['APPDIR', 'ARGV0', 'OWD']) delete env[name];
  return image;
}

/**
 * Apply both cures to this process's environment, which every child inherits.
 * A no-op on Windows, and the shell is only asked when the panel is installed: run from a
 * terminal it already has the right PATH.
 */
function fixEnvironment({ packaged, env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return { appImage: null, pathFromShell: false };
  const appImage = stripAppImage(env);
  let pathFromShell = false;
  if (packaged) {
    const shellPath = loginShellPath(env);
    if (shellPath) {
      env.PATH = mergePath(env.PATH, shellPath);
      pathFromShell = true;
    }
  }
  return { appImage, pathFromShell };
}

module.exports = { mergePath, loginShellPath, stripAppImage, fixEnvironment };
