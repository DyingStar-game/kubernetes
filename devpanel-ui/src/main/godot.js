'use strict';

const platform = require('./platform');
const { DevToken } = require('./devtoken');

/**
 * Everything that launches or cleans up Godot processes.
 *
 * The key discovery this module is built on: the editor's "Run Instances" feature
 * tags are passed to the child process through the GODOT_EDITOR_CUSTOM_FEATURES
 * environment variable. Setting it ourselves reproduces exactly what F5 does --
 * which means the panel can start the dedicated server directly and capture its
 * stdout at the source, instead of scraping a shared log file.
 *
 * Verified with Godot 4.7 mono (double precision):
 *   without the variable        -> OS.has_feature("dedicated_server") == false
 *   GODOT_EDITOR_CUSTOM_FEATURES=dedicated_server -> true
 */
class Godot {
  constructor({ config, log, procs, runtimeDir }) {
    this.cfg = config;
    this.log = log;
    this.procs = procs;
    this.tokens = runtimeDir ? new DevToken({ runtimeDir, log, config }) : null;
  }

  /**
   * Environment every Godot process needs.
   *
   * GODOT_SHARP_NUPKGS is not optional for this project: the C# packages must come from
   * the custom double-precision build, not from nuget.org (those crash at runtime).
   */
  _env(extra = {}) {
    const env = { ...extra };
    if (this.cfg.paths.godotSharpNupkgs) env.GODOT_SHARP_NUPKGS = this.cfg.paths.godotSharpNupkgs;
    return env;
  }

  /**
   * What stops a Godot process from being launched at all, or null. Said in the log rather than
   * left to a "spawn ENOENT" that names nothing.
   */
  _missing() {
    if (!this.cfg.paths.godotExe) return 'the Godot executable is not set (see the settings)';
    if (!this.cfg.paths.godotProject) return 'the game project is not set (see the settings)';
    return null;
  }

  /**
   * Where the dedicated server fetches its elevation tiles.
   *
   * Since the planet heights moved to an HTTP tile stream, a server with no tile source has NO
   * elevation: sampling silently falls back to the coarse global map, hundreds of metres off, and
   * the collision built from it drops the player through the ground onto the safety net. It does
   * not fail, it lies -- so nothing in the logs names it.
   *
   * The game reads the URL as a deployment setting: --tile-stream=, then DS_TILE_STREAM, then the
   * ini. We use the ENVIRONMENT rung on purpose, because the ini rung cannot work for our server:
   * every reader honours the `srvini=` override, so passing --srvini=test/ini/srv1.ini (which is how
   * you get port 8980 and the persistence URL) makes the server read that file INSTEAD of server.ini
   * -- and the six test/ini/srv*.ini carry no [stream] section. Adding one to each would copy a
   * deployment setting into six versioned test files; setting it here keeps it where it belongs.
   */
  _streamEnv() {
    const s = this.cfg.stream || {};
    const env = {};
    if (s.tilesUrl) env.DS_TILE_STREAM = s.tilesUrl;
    if (s.channel) env.DS_TILE_CHANNEL = s.channel;
    return env;
  }

  /**
   * PIDs the reaper must never touch.
   *
   * Not just the panel's own PIDs: on Windows the `*_console.exe` build launches the
   * engine as a CHILD process, so the PID recorded when starting the server belongs
   * to the wrapper, while the process actually holding the port -- headless, no window --
   * looks exactly like an orphan. Reaping by recorded PID alone therefore killed the
   * panel's own live server. Whoever holds the port is protected too.
   */
  async _protectedPids() {
    const own = this.procs
      .snapshot()
      .filter((p) => p.status === 'running' && p.pid)
      .map((p) => p.pid);

    if (this.procs.isRunning('godot-server')) {
      const { listenPid } = await platform.portInfo(this.cfg.ports.gameServer);
      if (listenPid != null && !own.includes(listenPid)) own.push(listenPid);
    }
    return own;
  }

  /**
   * The dedicated server: headless, tagged dedicated_server, listening on 8980.
   *
   * Idempotent on purpose. Clicking the button while a server is already up used to
   * reap "orphans" first and then spawn a rival instance -- which killed the running
   * server and dropped the session. Now the port is checked first: if anyone answers
   * on it, nothing is killed and nothing is started.
   */
  async startServer() {
    const missing = this._missing();
    if (missing) {
      this.log.note('Game server not started: ' + missing + '.', 'ERROR');
      return { ok: false, detail: missing };
    }

    const { listenPid } = await platform.portInfo(this.cfg.ports.gameServer);
    if (listenPid != null) {
      const mine = this.procs.isRunning('godot-server');
      this.log.note(
        mine
          ? 'The dedicated server is already running (PID ' + listenPid + '): nothing to do.'
          : 'A server already listens on ' + this.cfg.ports.gameServer + ' (PID ' + listenPid +
            '), started outside the panel (F5 in the editor?). Close it first, or use "Kill ghost servers".',
        mine ? 'INFO' : 'WARN'
      );
      return { ok: false, alreadyRunning: true, listenPid };
    }

    // Safe here, and only here: nothing holds the port, so anything headless left
    // around really is an orphan.
    await this.killOrphanServers();

    const args = [
      '--headless',
      '--path', this.cfg.paths.godotProject,
      ...(this.cfg.godot.serverArgs || []),
    ];
    return this.procs.start({
      id: 'godot-server',
      label: 'Godot server (dedicated_server)',
      source: 'godot-server',
      cmd: this.cfg.paths.godotExe,
      args,
      cwd: this.cfg.paths.godotProject,
      env: this._env({
        GODOT_EDITOR_CUSTOM_FEATURES: this.cfg.godot.serverFeatures || 'dedicated_server',
        ...this._streamEnv(),
      }),
    });
  }

  stopServer() {
    return this.procs.stop('godot-server');
  }

  /** The editor, for actually writing code. Its stdout is captured like any other source. */
  startEditor() {
    const missing = this._missing();
    if (missing) {
      this.log.note('Editor not started: ' + missing + '.', 'ERROR');
      return { ok: false, detail: missing };
    }
    return this.procs.start({
      id: 'godot-editor',
      label: 'Godot editor',
      source: 'godot-editor',
      cmd: this.cfg.paths.godotExe,
      args: ['--editor', '--path', this.cfg.paths.godotProject],
      cwd: this.cfg.paths.godotProject,
      env: this._env(),
    });
  }

  stopEditor() {
    return this.procs.stop('godot-editor');
  }

  /**
   * Game clients, laid out side by side -- the same geometry as the editor's
   * Run Instances dialog (--position 0,0 then --position <width>,0).
   *
   * Each one plays as its own test account (DevToken.playerFor) with a player token, so the
   * services answer it (DataPad, mission kiosks). No token to be had: it starts without, as before.
   */
  async startClient(index) {
    const missing = this._missing();
    if (missing) {
      this.log.note('Client not started: ' + missing + '.', 'ERROR');
      return { ok: false, detail: missing };
    }
    const w = this.cfg.godot.clientWidth;
    const h = this.cfg.godot.clientHeight;
    const x = index * w;
    const player = DevToken.playerFor(index);
    const token = this.tokens ? await this.tokens.tokenFor(player) : null;
    if (token) this.log.note('Client ' + (index + 1) + ': playing as ' + player + ' (test token).');
    return this.procs.start({
      id: 'godot-client-' + (index + 1),
      label: 'Client ' + (index + 1) + (token ? ' (' + player + ')' : ''),
      source: 'godot-client-' + (index + 1),
      cmd: this.cfg.paths.godotExe,
      args: [
        '--path', this.cfg.paths.godotProject,
        '--position', x + ',0',
        '--resolution', w + 'x' + h,
        ...(this.cfg.godot.clientArgs || []),
        ...(token ? ['--token=' + token] : []),
      ],
      cwd: this.cfg.paths.godotProject,
      env: this._env(),
    });
  }

  async startClients(count) {
    const n = Math.max(0, Number(count) || 0);
    const started = [];
    for (let i = 0; i < n; i++) {
      if (!this.procs.isRunning('godot-client-' + (i + 1))) started.push(await this.startClient(i));
    }
    return started;
  }

  async stopClients() {
    for (const p of this.procs.snapshot()) {
      if (p.id.startsWith('godot-client-') && p.status === 'running') await this.procs.stop(p.id);
    }
  }

  /**
   * Reap orphan headless Godot servers.
   *
   * When the editor is closed without stopping the game first, its headless run
   * instance survives and keeps holding port 8980, so the next server cannot bind
   * it. A headless Godot has no window, hence the MainWindowTitle test.
   *
   * IMPORTANT: our own dedicated server is headless too, so it matches that test.
   * Every PID the panel currently owns is excluded, otherwise this button would
   * kill the very server it just started.
   */
  async killOrphanServers() {
    const keepPids = await this._protectedPids();

    const r = await platform.reapOrphanGodot({ exePath: this.cfg.paths.godotExe, keepPids });

    if (r.killed > 0) {
      this.log.note('Ghost Godot servers killed: ' + r.killed + '.');
    } else {
      this.log.note('No ghost Godot server to kill.');
    }
    return r;
  }
}

module.exports = { Godot };
