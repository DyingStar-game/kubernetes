'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Finding things so the user does not have to type them.
 *
 * Everything here is a SUGGESTION: a detected value fills a setting the user left empty, it is
 * shown as such in the settings screen, and it is never written to config.json. So moving a
 * folder never leaves a stale path behind, and what the user did choose is never second-guessed.
 *
 * All of it is plain filesystem lookups -- no process is started -- so it is cheap enough to run
 * at every start.
 */

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

/**
 * Absolute path of a command, as the system would resolve it from PATH, or null.
 *
 * On Windows PATHEXT decides which extensions count. A `.cmd` or `.bat` hit is reported but
 * flagged: such a shim cannot be started without a shell, so the panel cannot use it as it is.
 */
function which(command, { env = process.env, platform = process.platform } = {}) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (isFile(candidate)) {
        const shim = /\.(cmd|bat)$/i.test(candidate);
        return { path: candidate, shim };
      }
    }
  }
  return null;
}

/** The command-line tools the panel (and the repository's scripts) call. */
const TOOLS = ['docker', 'minikube', 'kubectl', 'helm', 'git'];

function detectTools(opts) {
  const out = {};
  for (const tool of TOOLS) {
    const hit = which(tool, opts);
    out[tool] = hit ? { found: true, path: hit.path, shim: hit.shim } : { found: false, path: null, shim: false };
  }
  return out;
}

/**
 * The kubernetes repository: recognised by its dev-projects.yaml.
 *
 * Run from its sources, the panel lives INSIDE that repository, so its parent folder is the
 * answer. Otherwise look for a `kubernetes` folder next to the panel.
 */
function detectKubernetesRepo({ appRoot, workspace }) {
  const candidates = [
    // The workspace the user chose comes first: an installed panel has nothing around itself.
    ...(workspace ? [path.join(workspace, 'kubernetes')] : []),
    path.resolve(appRoot, '..'),
    path.resolve(appRoot, '..', 'kubernetes'),
    path.resolve(appRoot, '..', '..', 'kubernetes'),
  ];
  return candidates.find((dir) => isFile(path.join(dir, 'dev-projects.yaml'))) || null;
}

/**
 * The game project: a folder holding project.godot next to the kubernetes repository (the
 * layout dev-projects.yaml itself assumes). A folder named after the game wins over any other
 * Godot project that happens to sit there.
 */
function detectGodotProject({ kubernetesRepo }) {
  if (!kubernetesRepo) return null;
  const workspace = path.resolve(kubernetesRepo, '..');
  const projects = listDir(workspace)
    .map((name) => path.join(workspace, name))
    .filter((dir) => isFile(path.join(dir, 'project.godot')));
  if (!projects.length) return null;
  const named = projects.find((dir) => /^dyingstar/i.test(path.basename(dir)));
  return named || projects.sort()[0];
}

/** Is this file name a Godot editor binary of the kind the project needs (mono build)? */
function looksLikeGodot(name, platform) {
  if (!/^Godot_v.*mono/i.test(name)) return false;
  if (platform === 'win32') return /\.exe$/i.test(name);
  // Both systems' builds can sit side by side in the same folder: never pick the other one's.
  return !/\.(exe|zip|tpz|txt|md|json|pck|so|dll)$/i.test(name);
}

/**
 * The Godot executable: looked for in a `Godot` folder next to the repositories, two levels deep
 * (the release archive unpacks into a folder of its own). On Windows the `_console` build is
 * preferred: it is the one whose output can be captured.
 */
function detectGodotExe({ kubernetesRepo, platform = process.platform }) {
  if (!kubernetesRepo) return null;
  const workspace = path.resolve(kubernetesRepo, '..');
  const roots = listDir(workspace)
    .filter((name) => /^godot/i.test(name))
    .map((name) => path.join(workspace, name))
    .filter(isDir);

  const found = [];
  for (const root of roots) {
    for (const name of listDir(root)) {
      const full = path.join(root, name);
      if (isFile(full) && looksLikeGodot(name, platform)) found.push(full);
      else if (isDir(full)) {
        for (const inner of listDir(full)) {
          const innerFull = path.join(full, inner);
          if (isFile(innerFull) && looksLikeGodot(inner, platform)) found.push(innerFull);
        }
      }
    }
  }
  if (!found.length) return null;
  // Newest version first (names sort that way), and the console build ahead of the plain one.
  found.sort((a, b) => {
    const consoleA = /_console/i.test(a) ? 0 : 1;
    const consoleB = /_console/i.test(b) ? 0 : 1;
    const byVersion = path.dirname(b).localeCompare(path.dirname(a));
    return byVersion || (consoleA - consoleB) || a.localeCompare(b);
  });
  return found[0];
}

/** The C# packages of a Godot build: GodotSharp/Tools/nupkgs next to its executable. */
function detectGodotSharpNupkgs({ godotExe }) {
  if (!godotExe) return null;
  const dir = path.join(path.dirname(godotExe), 'GodotSharp', 'Tools', 'nupkgs');
  return isDir(dir) ? dir : null;
}

/** Docker Desktop at its standard install location (Windows). */
function detectDockerDesktop({ env = process.env, platform = process.platform }) {
  if (platform !== 'win32') return null;
  const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean);
  for (const root of roots) {
    const exe = path.join(root, 'Docker', 'Docker', 'Docker Desktop.exe');
    if (isFile(exe)) return exe;
  }
  return null;
}

/** 'fr' for a French system, 'en' for everything else. */
function detectLanguage({ locale }) {
  return /^fr\b/i.test(String(locale || '')) ? 'fr' : 'en';
}

/**
 * Run every detector. Later ones build on earlier ones (the game project is looked for next to
 * the kubernetes repository), and each takes the user's own value when there is one -- so
 * choosing the repository by hand is enough for the rest to be found around it.
 *
 * @param {object} known  values the user set, keyed like the settings ("paths.kubernetesRepo")
 */
function detectAll({ appRoot, known = {}, locale, env = process.env, platform = process.platform }) {
  const out = {};
  out.language = detectLanguage({ locale });
  out.kubernetesRepo = detectKubernetesRepo({ appRoot, workspace: known['paths.workspace'] });
  const kubernetesRepo = known['paths.kubernetesRepo'] || out.kubernetesRepo;
  // The workspace is simply where the kubernetes repository sits, when there is one.
  out.workspace = kubernetesRepo ? path.resolve(kubernetesRepo, '..') : null;
  out.godotProject = detectGodotProject({ kubernetesRepo });
  out.godotExe = detectGodotExe({ kubernetesRepo, platform });
  const godotExe = known['paths.godotExe'] || out.godotExe;
  out.godotSharpNupkgs = detectGodotSharpNupkgs({ godotExe });
  out.dockerDesktop = detectDockerDesktop({ env, platform });
  return out;
}

/** `~/foo` -> `/home/you/foo`. spawn() does not expand it, and a leading ~ in a path is a classic trap. */
function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

module.exports = {
  TOOLS,
  which,
  detectTools,
  detectKubernetesRepo,
  detectGodotProject,
  detectGodotExe,
  detectGodotSharpNupkgs,
  detectDockerDesktop,
  detectLanguage,
  detectAll,
  expandHome,
  isFile,
  isDir,
};
