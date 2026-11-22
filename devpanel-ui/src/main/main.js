'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Survive ELECTRON_RUN_AS_NODE.
 *
 * A VS Code integrated terminal exports that variable (its extension host runs that
 * way). Inherited by our launch, it makes the Electron binary behave as plain Node:
 * require('electron') then returns the path to the binary instead of the module, and
 * `app` is undefined -- the app died on startup with a cryptic error.
 *
 * Rather than only documenting the trap, detect it and relaunch ourselves cleanly.
 * The guard variable stops that from ever becoming a loop.
 */
const electronModule = require('electron');
if (typeof electronModule === 'string') {
  if (process.env.DS_DEVPANEL_RELAUNCHED === '1') {
    console.error('devpanel: Electron refuses to start (ELECTRON_RUN_AS_NODE is set).');
    process.exit(1);
  }
  const { spawn } = require('node:child_process');
  const env = { ...process.env, DS_DEVPANEL_RELAUNCHED: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Forward our own arguments (--data-dir, --smoke-test...): the relaunch must be the same launch.
  spawn(electronModule, [path.join(__dirname, '..', '..'), ...process.argv.slice(2)], {
    env, detached: true, stdio: 'ignore',
  }).unref();
  process.exit(0);
}

// Also keep it out of every child process we spawn (Godot, kubectl, the stack scripts...).
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, shell, dialog } = electronModule;
const { resolvePaths, argValue, hasFlag } = require('./paths');

// Before anything is spawned: an installed panel does not get a terminal's environment.
const ENVIRONMENT = require('./env').fixEnvironment({ packaged: app.isPackaged });

// Before the lock below: the lock is keyed on the data directory (see paths.js).
const PATHS = resolvePaths(app);

/**
 * One panel per data directory.
 *
 * A second instance on the same directory would fight the first for the API port and, worse,
 * its LogBus would rotate the log files the running instance is writing to. Claim the lock
 * BEFORE any of that is set up; a duplicate launch just focuses the existing window.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { LogBus } = require('./logbus');
const { ProcManager } = require('./procman');
const { Probes } = require('./probes');
const { RelinkWatcher } = require('./relink');
const { K8s } = require('./k8s');
const { Godot } = require('./godot');
const { Npc } = require('./npc');
const { Telepresence } = require('./telepresence');
const { Network } = require('./network');
const { Toolchain } = require('./installer');
const { Setup } = require('./setup');
const { Services } = require('./services');
const { PodLogs } = require('./podlogs');
const { Api } = require('./api');
const { ConfigStore } = require('./config');
const { detectAll, detectTools } = require('./detect');
const { MODULES, resolveModules, loadProfiles } = require('./modules');
const i18n = require('./i18n');
const { t } = i18n;
const platformLayer = require('./platform');

const ROOT = PATHS.appRoot;            // the code: read-only once packaged
const LOG_DIR = PATHS.logDir;
const RUNTIME_DIR = PATHS.runtimeDir;

/**
 * A headless self-check: load the window, push one state, optionally save a picture of the page,
 * then quit. It is what CI runs on the packaged build, and what lets a change to the interface be
 * looked at without touching the panel someone is working with (pair it with --data-dir).
 *
 *   --smoke-test                 run the check and exit (0 = the window loaded)
 *   --screenshot=<file.png>      save the rendered page there before exiting
 *   --smoke-wait-ms=<n>          how long to let the page settle (default 2500)
 */
const SMOKE = {
  on: hasFlag(process.argv, 'smoke-test'),
  screenshot: argValue(process.argv, 'screenshot'),
  waitMs: Number(argValue(process.argv, 'smoke-wait-ms')) || 2500,
};

// --- configuration ----------------------------------------------------------
//
// The settings are declared in settings-schema.js; config.json (in the data directory) only
// holds what the user chose. See config.js for the layering.

/**
 * A panel run from its sources used to keep config.json next to the code. Carry it over once --
 * a copy: the original is never modified -- so an existing setup keeps working untouched.
 * An explicit --data-dir is an isolated instance and starts clean.
 */
let configImportedFrom = null;
function carryOverLegacyFiles() {
  if (fs.existsSync(PATHS.configFile)) return;
  if (PATHS.dataDirOverridden || app.isPackaged || !fs.existsSync(PATHS.legacyConfigFile)) return;
  try {
    fs.copyFileSync(PATHS.legacyConfigFile, PATHS.configFile);
    configImportedFrom = PATHS.legacyConfigFile;
  } catch { return; }
  // The cached player tokens come along (they are valid for months); the logs do not.
  const tokens = path.join(PATHS.legacyRuntimeDir, 'player-tokens.json');
  if (fs.existsSync(tokens)) {
    try {
      fs.mkdirSync(PATHS.runtimeDir, { recursive: true });
      fs.copyFileSync(tokens, path.join(PATHS.runtimeDir, 'player-tokens.json'));
    } catch { /* a cache: the panel asks Keycloak again */ }
  }
}
carryOverLegacyFiles();

// The system language, readable before the app is ready (app.getLocale() is not).
const SYSTEM_LOCALE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return 'en'; }
})();

const configStore = new ConfigStore({
  file: PATHS.configFile,
  detect: (known) => detectAll({ appRoot: PATHS.appRoot, known, locale: SYSTEM_LOCALE }),
}).load();

// ONE object for the panel's whole life: changing a setting rebuilds it in place, so every
// module below sees the new value at its next use.
const config = configStore.config;

// The language is fixed for the life of the process (changing it asks for a restart): the window
// is handed its texts once, at load.
i18n.setLanguage(config.ui.language);

// Settings changed since start that only apply after a restart of the panel.
const restartPending = new Set();

// --- modules and profiles ---------------------------------------------------
//
// `modules` is { id: bool }: which bricks of the panel run. ONE object, rebuilt in place, handed
// to whatever needs to know -- same idea as `config`.

const PROFILE_DIRS = [path.join(PATHS.appRoot, 'profiles'), PATHS.profilesDir];
const modules = {};
let moduleDetail = {};
let profileSet = { profiles: new Map(), problems: [] };
let profileNotes = [];

function refreshModules() {
  profileSet = loadProfiles(PROFILE_DIRS);
  const profile = profileSet.profiles.get(config.profile) || null;
  profileNotes = [...profileSet.problems];
  if (config.profile && !profile) profileNotes.push('profile "' + config.profile + '" not found: every module is on');
  for (const skipped of configStore.setProfileSettings(profile ? profile.settings : {})) {
    profileNotes.push('profile "' + profile.id + '": ' + skipped);
  }
  // No profile chosen: everything is on, which is what the panel did before profiles existed.
  moduleDetail = resolveModules(profile ? profile.modules : null, config.modules || {});
  for (const id of Object.keys(moduleDetail)) modules[id] = moduleDetail[id].on;
}
refreshModules();

/**
 * The sets of services the cluster should run, from the profile: null = every set (no profile, or
 * a profile that does not say).
 */
function wantedSets() {
  const profile = profileSet.profiles.get(config.profile) || null;
  if (!profile || !profile.sets) return null;
  // Telepresence's traffic manager is part of `core`: `telepresence` is no longer a set (start-dev
  // refuses it). Profiles of older versions may still list it: drop it.
  return profile.sets.filter((name) => name !== 'telepresence');
}

// --- wiring -----------------------------------------------------------------

const logBus = new LogBus({ logDir: LOG_DIR, maxLines: config.logs.maxLines });

// The tools the panel fetched itself go first on the PATH of everything it starts -- the
// repository's scripts included -- before anything is spawned.
const toolchain = new Toolchain({ toolsDir: PATHS.toolsDir, log: logBus });
if (fs.existsSync(toolchain.binDir)) toolchain.prependToPath();

const procs = new ProcManager(logBus, {
  clearLogsOnRestart: config.logs.clearOnRestart !== false,
});
const probes = new Probes(config, modules);
const k8s = new K8s({ config, log: logBus, procs });
const godot = new Godot({ config, log: logBus, procs, runtimeDir: RUNTIME_DIR });
// After `godot`: the watcher restarts the game server before a re-delivery (see _restartIfAlreadyLoaded),
// so it needs the real reference, not a hoisted one.
const relink = new RelinkWatcher({ config, probes, log: logBus, godot });
const telepresence = new Telepresence({ config, log: logBus, procs });
// With Telepresence, horizon only reaches the local game server through the intercept.
relink.canLink = async () => !modules.telepresence || telepresence.intercepted();
// The elevated hosts script must be a real file: inside a packaged application it sits next to
// the archive, not in it.
const network = new Network({
  config, log: logBus, procs,
  scriptsDir: app.isPackaged ? path.join(process.resourcesPath, 'scripts') : path.join(PATHS.appRoot, 'scripts'),
});
const npc = new Npc({ config, log: logBus, k8s });
const setup = new Setup({ config, log: logBus, procs, toolchain, modules });
const services = new Services({ config, log: logBus, procs, probes, godot, relink, telepresence, network, modules, wantedSets });

// ArgoCD gives the panel no log stream of its own: it reconciles the cluster and walks away.
// The panel therefore follows the pods itself and merges their logs into the same bus, which is
// what gives every service its tab and the live search. Started unconditionally: it simply
// stays quiet while the cluster is unreachable, and picks up on its own once the stack is
// there -- no start chain to coordinate with.
const podLogs = new PodLogs({ config, log: logBus });
// Not during a self-check: it would open one `kubectl logs -f` per pod for a few seconds of life.
if (!SMOKE.on && modules.cluster) podLogs.start();

let win = null;
let lastProbes = null;
let probeTimer = null;

const API_LEVEL = 4;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function buildState({ withProbes = true } = {}) {
  if (withProbes) {
    try {
      lastProbes = await probes.all();
    } catch (err) {
      lastProbes = { error: String(err && err.message) };
    }
    // The NPC service is not part of the k8s stack, so it is probed here rather than in Probes:
    // docker is its only source of truth and it has no bearing on the startup chain.
    if (lastProbes && !lastProbes.error && modules.npc) {
      try {
        lastProbes.npc = await npc.probe();
      } catch (err) {
        lastProbes.npc = { ok: false, detail: String(err && err.message) };
      }
    }
    if (lastProbes && !lastProbes.error && modules.cluster && lastProbes.minikube && lastProbes.minikube.ok) {
      try {
        lastProbes.sets = await k8s.setsState();
      } catch (err) {
        lastProbes.sets = { ok: false, sets: [], detail: String(err && err.message) };
      }
    }
    if (lastProbes && !lastProbes.error && modules.network) {
      try {
        lastProbes.network = await network.status();
      } catch (err) {
        lastProbes.network = { ok: false, detail: String(err && err.message) };
      }
    }
    if (lastProbes && !lastProbes.error && modules.telepresence) {
      try {
        lastProbes.telepresence = await telepresence.probe();
      } catch (err) {
        lastProbes.telepresence = { ok: false, detail: String(err && err.message) };
      }
    }
    // Let the live probes correct the two startup steps they can speak for, so a step that failed
    // once does not stay red after the thing was started by hand.
    services.syncStepsWithProbes(lastProbes);
  }
  return {
    probes: lastProbes,
    procs: procs.snapshot(),
    chain: services.chainState(),
    relink: relink.state(),
    config: {
      namespace: config.k8s.namespace,
      ports: config.ports,
      // Scripts find the API token and the .log files from here (runtime/, logs/).
      dataDir: PATHS.dataDir,
      logDir: LOG_DIR,
      apiUrl: config.api.enabled ? 'http://127.0.0.1:' + config.ports.api : '',
      clientCount: config.godot.clientCount,
      clearOnRestart: procs.clearLogsOnRestart,
    },
    sources: logBus.sourceList(),
    // Bumped when the renderer starts needing something new from this process: a hot-reloaded
    // interface can then tell that the process behind it is older, and ask for a restart.
    apiLevel: API_LEVEL,
    // Which bricks run, and the profile that decided it (null: none chosen yet, everything on).
    modules: { ...modules },
    profile: config.profile || null,
    settings: {
      language: config.ui.language,
      missing: configStore.missingRequired(),
      restartPending: [...restartPending],
    },
  };
}

async function pushState(withProbes = true) {
  send('panel:state', await buildState({ withProbes }));
}

// --- action dispatcher (shared by the UI and the HTTP API) -------------------

// Names from before the ArgoCD migration, still accepted so scripts written against the local
// API keep working.
const ACTION_ALIASES = {
  'start-skaffold': 'start-stack',
  'stop-skaffold': 'stop-stack',
  'clean-dev': 'delete-cluster',
};

// The module each action belongs to. An action of a module that is switched off is refused, for
// the window and for the local API alike. Actions not listed here are always available.
const ACTION_MODULE = {
  'start-docker': 'docker',
  'start-minikube': 'cluster', 'start-stack': 'cluster', 'stop-stack': 'cluster',
  'use-minikube-context': 'cluster', 'restart-deployment': 'cluster', 'delete-pod': 'cluster',
  'list-deployments': 'cluster',
  'port-forward': 'horizon',
  'start-godot-server': 'gameServer', 'stop-godot-server': 'gameServer', 'kill-orphan-godot': 'gameServer',
  'relink-now': 'relink', 'relink-watch': 'relink',
  'start-clients': 'clients', 'stop-clients': 'clients',
  'start-editor': 'editor', 'stop-editor': 'editor',
  'restart-npc': 'npc',
  'network-repair': 'network', 'network-hosts': 'network',
  'telepresence-connect': 'telepresence', 'telepresence-intercept': 'telepresence',
  'telepresence-leave': 'telepresence', 'telepresence-quit': 'telepresence',
  'read-build-targets': 'build', 'build-image': 'build',
  'set-add': 'cluster', 'set-remove': 'cluster',
  'purge-scylla': 'danger', 'delete-cluster': 'danger', 'clean-env': 'danger',
};

async function doAction(requested, payload = {}) {
  const action = ACTION_ALIASES[requested] || requested;
  const owner = ACTION_MODULE[action];
  if (owner && !modules[owner]) {
    return { ok: false, code: 'module-disabled', module: owner, detail: 'the "' + owner + '" module is switched off' };
  }
  switch (action) {
    case 'start-all':
      // Fire and forget: the chain reports progress through state pushes.
      services.startAll({ withClients: Number(payload.clients) || 0 }).then(() => pushState());
      return { ok: true, detail: 'start sequence launched' };

    case 'abort':
      services.abort();
      return { ok: true };

    case 'stop-all':
      await services.stopAll({ stopMinikube: !!payload.stopMinikube });
      return { ok: true };

    case 'start-docker':
      return { ok: await services.startDocker() };

    case 'start-minikube':
      return { ok: await services.startMinikube() };

    case 'start-stack': {
      if (await services.stackInstalled() && !(await services.stackAlreadyUp())) {
        logBus.note('The stack is installed and its pods are coming back: nothing to start, only to wait.');
        return { ok: true, detail: 'installed, pods coming back' };
      }
      // Same rule as the start chain: ask the condition first. A stack ArgoCD is already keeping
      // up needs nothing started, and start-dev wants elevated rights (its tunnel and the hosts
      // file) that the panel does not have. Saying so beats a raw script error in the stack tab.
      const deployed = await services.stackAlreadyUp();
      if (deployed) {
        logBus.note('Stack already deployed (' + deployed + '): nothing to start.');
        return { ok: true, detail: deployed };
      }
      logBus.note(
        (config.network && config.network.mode) === 'tunnel'
          ? 'Tunnel mode: start-dev needs elevated rights (minikube tunnel + the hosts file). If it fails '
            + 'here, run it ONCE from an elevated terminal, then come back to the panel.'
          : 'start-dev runs without the tunnel (the panel\'s network layer reaches the cluster): no '
            + 'administrator rights needed.'
      );
      services.startStack();
      return { ok: true };
    }

    case 'delete-cluster':
      // Irreversible: minikube and every database in it. The renderer asks for the confirmation;
      // a script has to say it means it.
      if (payload.confirm !== true) {
        return { ok: false, detail: 'delete-cluster destroys the cluster and its data: pass "confirm": true' };
      }
      services.deleteCluster();
      return { ok: true };

    case 'clean-env':
      // Irreversible: stops everything the panel started, then deletes the cluster (clean-dev
      // also drops the tunnel, Telepresence and the hosts entries).
      if (payload.confirm !== true) {
        return { ok: false, detail: 'clean-env stops everything and destroys the cluster and its data: pass "confirm": true' };
      }
      await services.cleanEnv();
      return { ok: true };

    case 'stop-stack':
      await services.stopStack();
      return { ok: true };

    case 'start-godot-server':
      // startServer reaps orphans itself, but only once it knows the port is free.
      return await godot.startServer();

    case 'stop-godot-server':
      await godot.stopServer();
      return { ok: true };

    case 'network-repair':
      return await network.ensureRelays();

    case 'network-hosts':
      return network.writeHosts();

    case 'telepresence-connect':
      telepresence.connect();
      return { ok: true };

    case 'telepresence-intercept':
      telepresence.intercept();
      return { ok: true };

    case 'telepresence-leave':
      telepresence.leave();
      return { ok: true };

    case 'telepresence-quit':
      telepresence.quit();
      return { ok: true };

    // --- the setup assistant
    case 'setup-install-tool':
      if (!payload.id) return { ok: false, detail: 'field "id" is required' };
      return await setup.installTool(payload.id);

    case 'setup-install-system':
      if (!payload.id) return { ok: false, detail: 'field "id" is required' };
      return setup.installSystem(payload.id);

    case 'setup-clone':
      if (!payload.id) return { ok: false, detail: 'field "id" is required' };
      return setup.cloneRepo(payload.id);

    case 'setup-fetch-godot':
      return await setup.fetchGodot();

    case 'restart-npc':
      return npc.restart();

    case 'start-editor':
      godot.startEditor();
      return { ok: true };

    case 'stop-editor':
      await godot.stopEditor();
      return { ok: true };

    case 'start-clients':
      await godot.startClients(Number(payload.count) || config.godot.clientCount);
      return { ok: true };

    case 'stop-clients':
      await godot.stopClients();
      return { ok: true };

    case 'kill-orphan-godot':
      return await godot.killOrphanServers();

    case 'relink-now':
      // The button means "restart horizon now": no waiting to see whether it reconnects by itself.
      return await relink.relink('manual request', { force: true });

    case 'relink-watch':
      if (payload.on === false) relink.stop(); else relink.start();
      return { ok: true, state: relink.state() };

    case 'restart-deployment':
      if (!payload.name) return { ok: false, detail: 'field "name" is required' };
      return await k8s.restartDeployment(payload.name);

    case 'delete-pod':
      if (!payload.name) return { ok: false, detail: 'field "name" is required' };
      return await k8s.deletePod(payload.name);

    case 'list-deployments':
      return { ok: true, deployments: await k8s.listDeployments() };

    case 'purge-scylla':
      return await k8s.purgeScylla();

    case 'port-forward':
      if (payload.on === false) {
        await k8s.stopPortForward();
      } else {
        k8s.startPortForward();
      }
      return { ok: true };

    case 'use-minikube-context':
      return await k8s.useMinikubeContext();

    case 'read-build-targets':
      return k8s.readBuildTargets();

    case 'set-add':
    case 'set-remove':
      if (!payload.set) return { ok: false, detail: 'field "set" is required' };
      // Removing a set deletes its workloads and their databases: a script has to say it means it.
      if (action === 'set-remove' && payload.confirm !== true) {
        return { ok: false, detail: 'set-remove deletes the set\'s workloads and databases: pass "confirm": true' };
      }
      return k8s.changeSet(action === 'set-add' ? 'add' : 'remove', payload.set);

    case 'build-image':
      if (!payload.target) return { ok: false, detail: 'field "target" is required' };
      return k8s.buildImage(payload.target);

    case 'stop-proc':
      await procs.stop(payload.id);
      return { ok: true };

    case 'clear-logs': {
      // source omitted or "*" clears everything; otherwise a comma-separated list.
      const target = payload.source && payload.source !== '*'
        ? String(payload.source).split(',').map((s) => s.trim()).filter(Boolean)
        : null;
      const cleared = logBus.clear(target);
      return { ok: true, cleared };
    }

    case 'set-clear-on-restart':
      procs.clearLogsOnRestart = payload.on !== false;
      logBus.note('Clear a log when its process restarts: ' + (procs.clearLogsOnRestart ? 'on' : 'off') + '.');
      return { ok: true, on: procs.clearLogsOnRestart };

    case 'open-logs-folder':
      shell.openPath(LOG_DIR);
      return { ok: true, path: LOG_DIR };

    case 'open-data-folder':
      shell.openPath(PATHS.dataDir);
      return { ok: true, path: PATHS.dataDir };

    case 'check-prerequisites': {
      // The repository's own check (tools and their versions, memory, disk...), in a log tab.
      if (!config.paths.kubernetesRepo) {
        return { ok: false, detail: 'the kubernetes repository is not set (see the settings)' };
      }
      const { cmd, args } = platformLayer.checkDevCommand(config);
      procs.start({ id: 'check-dev', label: 'check-dev', source: 'check-dev', cmd, args });
      return { ok: true, detail: 'running: see the "check-dev" tab' };
    }

    default:
      return { ok: false, detail: 'unknown action: ' + requested };
  }
}

// --- HTTP API ---------------------------------------------------------------

const api = new Api({
  config,
  runtimeDir: RUNTIME_DIR,
  logBus,
  getState: () => buildState({ withProbes: true }),
  doAction,
});

// --- window -----------------------------------------------------------------

// Declared here (not next to the shutdown handlers) because the window's own close
// handler reads it, and a reader should never sit above its declaration.
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#151413',
    title: t('app.title'),
    icon: path.join(ROOT, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    // A self-check shows its window without taking the focus (see below): a hidden window is not
    // painted on every platform, and an unpainted page cannot be captured.
    show: !SMOKE.on,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (SMOKE.on) win.showInactive();

  win.webContents.on('did-finish-load', async () => {
    // Replay the buffer so a reload does not lose history.
    send('panel:logs', logBus.entries.slice(-config.logs.rendererMaxLines));
    await pushState();
    // --open=settings: start on that screen (used to look at it in a self-check).
    const openWhat = argValue(process.argv, 'open');
    if (openWhat) send('panel:open', openWhat);
    if (SMOKE.on) finishSmokeTest();
  });

  if (SMOKE.on) {
    win.webContents.on('did-fail-load', (_e, code, description) => {
      console.error('smoke test: the window failed to load (' + code + ' ' + description + ')');
      app.exit(1);
    });
  }

  /**
   * Closing the panel takes down what it started -- the Godot server, the clients, the
   * relays. That is the right default (the panel owns their output; a surviving process
   * would be an invisible orphan), but it must never happen silently on a stray click.
   * The cluster is not concerned: ArgoCD keeps it up, panel or not.
   */
  win.on('close', (e) => {
    if (quitting) return;
    const running = procs.snapshot().filter((p) => p.status === 'running');
    if (!running.length) return;

    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: [t('quit.stopAll'), t('quit.leave'), t('quit.cancel')],
      defaultId: 0,
      cancelId: 2,
      title: t('quit.title'),
      message: t('quit.message', { n: running.length }),
      detail: running.map((p) => '  • ' + p.label).join('\n') + '\n\n' + t('quit.detail'),
    });

    if (choice === 2) return;             // cancel
    quitting = true;
    if (probeTimer) clearInterval(probeTimer);
    relink.stop();
    api.stop();

    if (choice === 1) {                   // leave them running
      logBus.close();
      app.exit(0);
      return;
    }
    podLogs.stop();
    procs.stopAll().then(() => {
      logBus.close();
      app.exit(0);
    });
  });

  win.on('closed', () => { win = null; });
}

/**
 * End of a self-check: let the page settle, save the picture if one was asked for, and leave.
 * Nothing was started, so there is nothing to stop -- only the log files to close.
 */
let smokeDone = false;
async function finishSmokeTest() {
  if (smokeDone) return;
  smokeDone = true;
  let code = 0;
  try {
    await new Promise((resolve) => setTimeout(resolve, SMOKE.waitMs));
    if (SMOKE.screenshot) {
      const image = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(path.resolve(SMOKE.screenshot)), { recursive: true });
      fs.writeFileSync(path.resolve(SMOKE.screenshot), image.toPNG());
    }
    console.log('smoke test: ok (data dir ' + PATHS.dataDir + ')');
  } catch (err) {
    console.error('smoke test: ' + String(err && err.stack ? err.stack : err));
    code = 1;
  }
  quitting = true;
  if (probeTimer) clearInterval(probeTimer);
  api.stop();
  logBus.close();
  app.exit(code);
}

/**
 * Hot reload of the interface.
 *
 * The UI lives in the window; the Godot server and the clients are owned
 * by the main process. So reloading the window costs nothing: every child process
 * keeps running, and did-finish-load replays the log buffer straight back into the
 * fresh page. Editing style.css or app.js therefore updates the panel live, while
 * the stack stays up.
 *
 * (Ctrl+R does the same thing by hand -- this just removes the step.)
 * Changes to files under src/main/ still need a real restart: that process is the
 * one holding the pipes.
 */
function watchRendererFiles() {
  // An installed panel has no source files to watch: its interface lives in a read-only archive.
  if (app.isPackaged || config.dev.hotReloadRenderer === false) return;
  const dir = path.join(__dirname, '..', 'renderer');
  let timer = null;
  try {
    fs.watch(dir, (_evt, file) => {
      if (!file || !/\.(js|css|html)$/i.test(file)) return;
      clearTimeout(timer);
      // Editors write in bursts (temp file, rename, touch); debounce so one save
      // does not trigger three reloads.
      timer = setTimeout(() => {
        if (win && !win.isDestroyed()) {
          logBus.note('Interface hot-reloaded (' + file + '). Processes untouched.');
          win.webContents.reloadIgnoringCache();
        }
      }, 200);
    });
    logBus.note('Hot reload of the interface is on (src/renderer).');
  } catch (err) {
    logBus.note('Hot reload unavailable: ' + String(err && err.message), 'WARN');
  }
}

app.whenReady().then(() => {
  logBus.note('DyingStar dev panel started (' + platformLayer.name + '). Data directory: ' + PATHS.dataDir);
  if (configImportedFrom) {
    logBus.note('Settings imported from ' + configImportedFrom + ' (a copy: the original is left as it is).'
      + ' They now live in ' + PATHS.configFile + '.');
  }
  for (const problem of configStore.problems) {
    logBus.note('Settings: ' + problem.message, problem.level === 'error' ? 'ERROR' : 'WARN');
  }
  for (const note of profileNotes) logBus.note('Profiles: ' + note, 'WARN');
  const missing = configStore.missingRequired();
  if (missing.length) {
    logBus.note('Settings to fill in before the panel can do its job: ' + missing.join(', ')
      + ' (the settings screen opens by itself).', 'WARN');
  }
  api.start();
  createWindow();
  applyModules();
  watchRendererFiles();

  logBus.on('lines', (batch) => send('panel:logs', batch));
  logBus.on('cleared', (info) => { send('panel:cleared', info); pushState(false); });
  procs.on('change', () => pushState(false));
  services.on('change', () => pushState(false));
  relink.on('change', () => pushState(false));

  // 5 s is plenty for status lights, and each probe has its own cache on top, so a
  // tick usually costs nothing at all.
  probeTimer = setInterval(() => pushState(true), 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Someone double-clicked the shortcut again: bring the existing panel forward.
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
});

ipcMain.handle('panel:action', async (_evt, action, payload) => doAction(action, payload || {}));
ipcMain.handle('panel:state', async () => buildState({ withProbes: false }));
ipcMain.handle('panel:search', async (_evt, params) => logBus.search(params || {}));

// The window's texts. Synchronous on purpose: the page needs them before it draws anything, and
// this is a lookup in memory.
ipcMain.on('panel:i18n', (evt) => {
  evt.returnValue = { lang: i18n.language(), strings: i18n.tableFor(i18n.language()) };
});

// --- settings ---------------------------------------------------------------

/** Apply what the modules say to the long-running helpers; called at start and when they change. */
function applyModules() {
  if (!SMOKE.on) {
    if (modules.cluster) podLogs.start(); else podLogs.stop();
  }
  // The watcher runs whenever its module is on. It only ever acts while a local game server
  // listens, so it costs nothing otherwise -- and it is what puts the link right after anything
  // done by hand (a server restarted, an intercept started after horizon had already connected
  // to the cluster's own server).
  if (!SMOKE.on) {
    if (modules.relink) relink.start(); else relink.stop();
  }
  probes.invalidate();
}

function describeProfiles() {
  const lang = config.ui.language;
  const text = (t) => (t && (t[lang] || t.en)) || '';
  return {
    profile: config.profile || null,
    profiles: [...profileSet.profiles.values()].map((p) => ({
      id: p.id, name: text(p.name), description: text(p.description), modules: p.modules,
    })),
    modules: MODULES.map((mod) => ({
      id: mod.id,
      label: text(mod.label),
      help: text(mod.help),
      requires: mod.requires,
      ...moduleDetail[mod.id],
    })),
    overrides: { ...(config.modules || {}) },
    notes: profileNotes,
    userProfilesDir: PATHS.profilesDir,
  };
}

function describeSettings() {
  return {
    ...configStore.describe(config.ui.language),
    ...describeProfiles(),
    language: config.ui.language,
    tools: detectTools(),
    dataDir: PATHS.dataDir,
    restartPending: [...restartPending],
    packaged: app.isPackaged,
  };
}

ipcMain.handle('panel:settings:get', async () => describeSettings());

// What the setup assistant shows: what is there, what is missing, what is being fetched.
ipcMain.handle('panel:setup:get', async () => {
  // A clone or a download just finished may make something detectable: look again first.
  configStore.refreshDetection();
  return {
    ...(await setup.status()),
    missing: configStore.missingRequired(),
    stack: lastProbes && lastProbes.pods ? { ok: !!lastProbes.pods.ok, detail: lastProbes.pods.detail || '' } : null,
    modules: { ...modules },
  };
});

ipcMain.handle('panel:settings:set', async (_evt, patch) => {
  const result = configStore.apply(patch || {});
  if (result.ok) {
    for (const key of result.restart) restartPending.add(key);
    if (result.changed.length) {
      logBus.note('Settings changed: ' + result.changed.join(', ')
        + (result.restart.length ? ' (restart the panel to apply ' + result.restart.join(', ') + ')' : '') + '.');
    }
    // The probes cache answers computed from the old values.
    probes.invalidate();
    procs.clearLogsOnRestart = config.logs.clearOnRestart !== false;
    pushState(true);
  }
  return { ...result, settings: describeSettings() };
});

/**
 * Choose a profile and force modules on or off. `modules` is the full set of overrides
 * ({ id: bool }); a module left out follows the profile.
 */
ipcMain.handle('panel:profile:set', async (_evt, { profile, modules: overrides } = {}) => {
  if (profile !== undefined) {
    if (profile !== null && !profileSet.profiles.has(profile)) {
      return { ok: false, detail: 'unknown profile: ' + profile, settings: describeSettings() };
    }
    configStore.setReserved('profile', profile);
  }
  if (overrides !== undefined) {
    const clean = {};
    for (const mod of MODULES) {
      if (overrides && typeof overrides[mod.id] === 'boolean') clean[mod.id] = overrides[mod.id];
    }
    configStore.setReserved('modules', Object.keys(clean).length ? clean : null);
  }
  refreshModules();
  applyModules();
  const on = MODULES.filter((mod) => modules[mod.id]).map((mod) => mod.id);
  logBus.note('Profile: ' + (config.profile || 'none') + '. Modules on: ' + (on.join(', ') || 'none') + '.');
  pushState(true);
  return { ok: true, settings: describeSettings() };
});

/** A native "choose a file / a folder" dialog; resolves to the chosen path, or null. */
ipcMain.handle('panel:pick-path', async (_evt, { type, current } = {}) => {
  const options = {
    properties: [type === 'directory' ? 'openDirectory' : 'openFile'],
  };
  if (current && typeof current === 'string') options.defaultPath = current;
  const result = await dialog.showOpenDialog(win, options);
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

/**
 * Restart the panel (some settings only apply at start). Refused while it owns running
 * processes: restarting would stop them, and that is never something to do on the side.
 */
ipcMain.handle('panel:restart', async () => {
  const running = procs.snapshot().filter((p) => p.status === 'running');
  if (running.length) {
    return { ok: false, detail: 'stop what the panel started first: ' + running.map((p) => p.label).join(', ') };
  }
  quitting = true;
  if (probeTimer) clearInterval(probeTimer);
  relink.stop();
  api.stop();
  podLogs.stop();
  logBus.close();
  // An AppImage must be relaunched through the image itself, not the binary mounted inside it.
  const options = ENVIRONMENT.appImage ? { execPath: ENVIRONMENT.appImage } : {};
  app.relaunch(options);
  app.exit(0);
  return { ok: true };
});

// --- shutdown ---------------------------------------------------------------
//
// The window's own 'close' handler asks the user and does the teardown. These two
// are the fallbacks: quitting through the OS, the dock, or a second window.

app.on('window-all-closed', async () => {
  if (quitting) return;
  quitting = true;
  if (probeTimer) clearInterval(probeTimer);
  relink.stop();
  api.stop();
  podLogs.stop();
  await procs.stopAll();
  logBus.close();
  app.quit();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  const running = procs.snapshot().filter((p) => p.status === 'running');
  if (!running.length) return;
  e.preventDefault();
  quitting = true;
  if (probeTimer) clearInterval(probeTimer);
  relink.stop();
  api.stop();
  podLogs.stop();
  procs.stopAll().then(() => {
    logBus.close();
    app.quit();
  });
});

process.on('uncaughtException', (err) => {
  try {
    logBus.note('Unhandled exception: ' + (err && err.stack ? err.stack : String(err)), 'ERROR');
  } catch { /* nothing left to log with */ }
});
