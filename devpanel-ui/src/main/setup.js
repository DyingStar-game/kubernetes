'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./util');
const { which, isDir, isFile } = require('./detect');
const { downloadVerified, extractArchive, platformKey } = require('./installer');
const catalog = require('./repos.json');

/**
 * Setting a machine up from nothing.
 *
 * One object answers "what is there, what is missing" (`status()`), and each missing thing has
 * one action that gets it. The window draws the answer as a list of steps; nothing here knows
 * about the window.
 *
 * What it will and will not do by itself:
 *   - single binaries (kubectl, minikube, helm): fetched, checksum verified (installer.js);
 *   - the project's repositories: `git clone`, into ONE workspace folder, under the names the
 *     kubernetes repository expects. An existing clone is never pulled, switched or touched:
 *     ArgoCD deploys what that clone has checked out;
 *   - the project's Godot build: downloaded from its Releases page, checked against the digest
 *     GitHub publishes for the file, unpacked next to the repositories;
 *   - real installers (Docker, git, the .NET SDK): started through the system's package manager
 *     on Windows, where it asks for permission itself; on Linux the command is shown, not run --
 *     the panel never calls sudo.
 */

// Programs that need a real installer. `winget` is the id of the Windows package; `linux` is
// what to tell a Linux user, whose package manager we do not guess.
const SYSTEM_TOOLS = [
  {
    id: 'git', command: 'git', winget: 'Git.Git',
    url: 'https://git-scm.com/downloads',
    linux: 'sudo apt install git    (or: sudo dnf install git)',
  },
  {
    id: 'docker', command: 'docker', winget: 'Docker.DockerDesktop', restart: true,
    url: 'https://docs.docker.com/get-docker/',
    linux: 'https://docs.docker.com/engine/install/  then: sudo usermod -aG docker $USER  (log out and in)',
  },
  {
    id: 'dotnet', command: 'dotnet', winget: 'Microsoft.DotNet.SDK.9',
    url: 'https://dotnet.microsoft.com/download/dotnet/9.0',
    linux: 'https://learn.microsoft.com/dotnet/core/install/linux',
    neededBy: ['editor', 'gameServer', 'clients'],
  },
];

/** "4.7" from a project.godot (`config/features=PackedStringArray("4.7", "C#", ...)`), or null. */
function godotVersionOf(projectFile) {
  let text;
  try { text = fs.readFileSync(projectFile, 'utf8'); } catch { return null; }
  const line = text.split(/\r?\n/).find((l) => l.startsWith('config/features='));
  const m = line && line.match(/"(\d+\.\d+(?:\.\d+)?)"/);
  return m ? m[1] : null;
}

/** Which repositories the modules that are on need. */
function reposFor(modules) {
  const on = (id) => !modules || modules[id] !== false;
  return catalog.repos.filter((repo) => repo.always || repo.neededBy.some(on));
}

class Setup {
  constructor({ config, log, procs, toolchain, modules, fetchImpl = fetch }) {
    this.cfg = config;
    this.log = log;
    this.procs = procs;
    this.toolchain = toolchain;
    this.modules = modules;
    this.fetch = fetchImpl;
    this.busy = new Map();        // id -> { label, received, total } while something is fetched
    this.lastError = new Map();   // id -> message of the last failure
  }

  /** The folder the repositories and Godot live in, side by side. */
  workspace() {
    if (this.cfg.paths.workspace) return this.cfg.paths.workspace;
    if (this.cfg.paths.kubernetesRepo) return path.dirname(this.cfg.paths.kubernetesRepo);
    return '';
  }

  _repoDir(repo) {
    // What the settings point at wins over the conventional folder: an existing checkout may
    // have another name (the game is often cloned as something else than "DyingStar").
    if (repo.id === 'kubernetes' && this.cfg.paths.kubernetesRepo) return this.cfg.paths.kubernetesRepo;
    if (repo.id === 'game' && this.cfg.paths.godotProject) return this.cfg.paths.godotProject;
    const ws = this.workspace();
    return ws ? path.join(ws, repo.folder) : '';
  }

  /** Everything the setup screen shows. Cheap except `tools`, which runs each tool once. */
  async status() {
    const ws = this.workspace();
    const progress = (id) => (this.busy.has(id) ? { ...this.busy.get(id) } : null);
    const error = (id) => this.lastError.get(id) || null;

    const tools = (await this.toolchain.checkAll()).map((t) => ({
      ...t, kind: 'binary', busy: progress(t.id), error: error(t.id),
    }));
    const on = (id) => !this.modules || this.modules[id] !== false;
    const system = SYSTEM_TOOLS
      .filter((t) => !t.neededBy || t.neededBy.some(on))
      .map((t) => ({
        id: t.id, kind: 'system', ok: !!which(t.command), url: t.url, linux: t.linux,
        canInstall: process.platform === 'win32' && !!which('winget'),
        restart: !!t.restart,
        busy: this.procs.isRunning('setup-' + t.id) ? { label: 'winget' } : null,
        error: error(t.id),
      }));

    const repos = reposFor(this.modules).map((repo) => {
      const dir = this._repoDir(repo);
      const present = !!dir && isDir(path.join(dir, '.git')) && (!repo.marker || isFile(path.join(dir, repo.marker)));
      return {
        id: repo.id, folder: repo.folder, dir, url: repo.url, sizeMb: repo.sizeMb, ok: present,
        busy: this.procs.isRunning('setup-clone-' + repo.id) ? { label: 'git clone' } : null,
        error: error('repo-' + repo.id),
      };
    });

    const godotExe = this.cfg.paths.godotExe || '';
    const godot = {
      ok: !!godotExe && isFile(godotExe),
      exe: godotExe,
      nupkgs: this.cfg.paths.godotSharpNupkgs || '',
      nupkgsOk: !!this.cfg.paths.godotSharpNupkgs && isDir(this.cfg.paths.godotSharpNupkgs),
      wanted: godotVersionOf(path.join(this.cfg.paths.godotProject || '', 'project.godot')),
      needed: on('editor') || on('clients') || on('gameServer'),
      busy: progress('godot'),
      error: error('godot'),
    };

    return { workspace: ws, workspaceOk: !!ws && isDir(ws), tools, system, repos, godot };
  }

  // --- actions ----------------------------------------------------------------

  /** Run something long, remembering its progress and its failure for the screen. */
  async _track(id, label, work) {
    if (this.busy.has(id)) return { ok: false, detail: 'already running' };
    this.busy.set(id, { label, received: 0, total: 0 });
    this.lastError.delete(id);
    try {
      const result = await work((received, total) => this.busy.set(id, { label, received, total }));
      return { ok: true, ...result };
    } catch (err) {
      const message = String(err && err.message);
      this.lastError.set(id, message);
      this.log.note('Setup: ' + label + ' failed: ' + message, 'ERROR');
      return { ok: false, detail: message };
    } finally {
      this.busy.delete(id);
    }
  }

  /** Fetch one of the single-binary tools. */
  installTool(id) {
    return this._track(id, id, async (onProgress) => {
      await this.toolchain.install(id, { onProgress });
      this.toolchain.prependToPath();
      return {};
    });
  }

  /** Start the system's package manager for a program that needs a real installer (Windows). */
  installSystem(id) {
    const tool = SYSTEM_TOOLS.find((t) => t.id === id);
    if (!tool) return { ok: false, detail: 'unknown program: ' + id };
    if (process.platform !== 'win32' || !which('winget')) {
      return { ok: false, detail: 'no package manager the panel can drive here: install it from ' + tool.url };
    }
    this.lastError.delete(id);
    this.procs.start({
      id: 'setup-' + id,
      label: 'winget install ' + tool.winget,
      source: 'setup',
      cmd: 'winget',
      args: ['install', '--id', tool.winget, '-e', '--accept-source-agreements', '--accept-package-agreements'],
    });
    return { ok: true, detail: 'see the "setup" tab' };
  }

  /** Clone one repository into the workspace. Never touches a folder that already exists. */
  cloneRepo(id) {
    const repo = catalog.repos.find((r) => r.id === id);
    if (!repo) return { ok: false, detail: 'unknown repository: ' + id };
    const ws = this.workspace();
    if (!ws) return { ok: false, detail: 'choose the workspace folder first' };
    const dir = path.join(ws, repo.folder);
    if (fs.existsSync(dir)) {
      return { ok: false, detail: dir + ' already exists: the panel never touches an existing folder' };
    }
    if (!which('git')) return { ok: false, detail: 'git is not installed' };
    fs.mkdirSync(ws, { recursive: true });
    this.lastError.delete('repo-' + id);
    this.procs.start({
      id: 'setup-clone-' + id,
      label: 'git clone ' + repo.folder,
      source: 'setup',
      cmd: 'git',
      args: ['clone', '--progress', ...(repo.submodules ? ['--recurse-submodules'] : []), repo.url, dir],
    });
    return { ok: true, detail: 'see the "setup" tab' };
  }

  /**
   * Which file of the project's Godot releases this machine needs.
   * The version is the one the game project asks for; with no game project yet, the latest.
   */
  async godotRelease() {
    const wanted = godotVersionOf(path.join(this.cfg.paths.godotProject || '', 'project.godot'));
    const api = 'https://api.github.com/repos/' + catalog.godot.repository + '/releases/'
      + (wanted ? 'tags/' + wanted + '-stable' : 'latest');
    const res = await this.fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'devpanel' } });
    if (!res.ok) throw new Error('no Godot release found for ' + (wanted || 'the latest version') + ' (HTTP ' + res.status + ')');
    const release = await res.json();
    const suffix = catalog.godot.assets[platformKey()];
    const asset = (release.assets || []).find((a) => suffix && a.name.endsWith(suffix));
    if (!asset) throw new Error('release ' + release.tag_name + ' has no build for this system (' + platformKey() + ')');
    const sha256 = String(asset.digest || '').replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('GitHub publishes no checksum for ' + asset.name);
    return { tag: release.tag_name, name: asset.name, url: asset.browser_download_url, sha256, size: asset.size };
  }

  /** Download the project's Godot build and unpack it next to the repositories. */
  fetchGodot() {
    return this._track('godot', 'Godot', async (onProgress) => {
      const ws = this.workspace();
      if (!ws) throw new Error('choose the workspace folder first');
      const release = await this.godotRelease();
      const target = path.join(ws, catalog.godot.folder);
      const archive = path.join(this.toolchain.cacheDir, release.name);
      this.log.note('Fetching ' + release.name + ' (' + Math.round(release.size / 1048576) + ' MB) from the '
        + catalog.godot.repository + ' releases...');
      await downloadVerified({ url: release.url, dest: archive, sha256: release.sha256, onProgress, fetchImpl: this.fetch });
      await extractArchive(archive, target);
      fs.rmSync(archive, { force: true });
      this.log.note('Godot ' + release.tag + ' unpacked in ' + target + ' (checksum verified).');
      return { dir: target, tag: release.tag };
    });
  }
}

module.exports = { Setup, SYSTEM_TOOLS, godotVersionOf, reposFor };
