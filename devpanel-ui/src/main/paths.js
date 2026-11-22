'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Where the panel keeps what it writes.
 *
 * Nothing is ever written next to the code: once the panel is installed from a package that
 * folder is read-only (and inside an archive). Everything the user owns lives in ONE data
 * directory instead:
 *
 *   <data dir>/config.json    the user's settings (only what differs from the defaults)
 *   <data dir>/logs/          one .log per source, rotated at each start
 *   <data dir>/runtime/       the local API token, cached player tokens
 *   <data dir>/profiles/      user-made profiles, next to the bundled ones
 *   <data dir>/tools/         command-line tools the panel fetched itself
 *
 * The data directory is, in order: --data-dir=<path>, the DS_DEVPANEL_DATA_DIR environment
 * variable, then <per-user application data>/dyingstar-devpanel. The override is what lets two
 * panels run side by side (a test instance next to the one you work with): the single-instance
 * lock, the logs and the API token all follow the data directory.
 */
const DATA_DIR_NAME = 'dyingstar-devpanel';

/** Value of `--name=value` or `--name value` in an argument list, or null. */
function argValue(argv, name) {
  const flag = '--' + name;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg.startsWith(flag + '=')) return arg.slice(flag.length + 1);
    if (arg === flag && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) {
      return String(argv[i + 1]);
    }
  }
  return null;
}

/** True when the bare flag `--name` (or `--name=...`) is present. */
function hasFlag(argv, name) {
  const flag = '--' + name;
  return argv.some((a) => String(a) === flag || String(a).startsWith(flag + '='));
}

/** The data directory, and whether it was chosen explicitly (flag or environment). */
function resolveDataDir({ argv = [], env = {}, appDataDir }) {
  const chosen = argValue(argv, 'data-dir') || env.DS_DEVPANEL_DATA_DIR;
  if (chosen) return { dataDir: path.resolve(chosen), overridden: true };
  return { dataDir: path.join(appDataDir, DATA_DIR_NAME), overridden: false };
}

function buildPaths({ appRoot, dataDir, overridden = false }) {
  return {
    appRoot,
    dataDir,
    // An explicit data directory is an isolated instance: it starts clean and never imports the
    // settings of the panel that used to live next to the code.
    dataDirOverridden: overridden,
    configFile: path.join(dataDir, 'config.json'),
    logDir: path.join(dataDir, 'logs'),
    runtimeDir: path.join(dataDir, 'runtime'),
    profilesDir: path.join(dataDir, 'profiles'),
    toolsDir: path.join(dataDir, 'tools'),
    // Where the pre-packaging versions kept the same things; read once, never written.
    legacyConfigFile: path.join(appRoot, 'config.json'),
    legacyRuntimeDir: path.join(appRoot, '.runtime'),
  };
}

/**
 * Resolve every path and point Electron's own per-user storage at the data directory.
 *
 * Must run BEFORE app.requestSingleInstanceLock(): the lock is keyed on the userData path, so
 * this is also what makes "one panel per data directory" true.
 */
function resolvePaths(app, { argv = process.argv, env = process.env } = {}) {
  const appRoot = app.getAppPath();
  const { dataDir, overridden } = resolveDataDir({ argv, env, appDataDir: app.getPath('appData') });
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
  return buildPaths({ appRoot, dataDir, overridden });
}

module.exports = { DATA_DIR_NAME, argValue, hasFlag, resolveDataDir, buildPaths, resolvePaths };
