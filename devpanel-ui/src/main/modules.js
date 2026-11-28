'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The bricks of the panel, and the profiles that switch them on and off.
 *
 * A module is one thing the panel can take care of: the cluster, the local game server, the
 * game clients... Each owns its cards, its status lights, its steps of the start chain, its
 * health checks and its actions. Switching a module off removes ALL of that at once: nothing is
 * shown, nothing is probed, nothing is started, and its actions are refused -- for the window
 * and for the local API alike.
 *
 * Switching a module off never changes what the cluster deploys. It only changes what the panel
 * shows and does.
 *
 * A PROFILE is a named set of modules (plus default settings), stored as a JSON file:
 *   profiles/<id>.json              shipped with the panel
 *   <data dir>/profiles/<id>.json   yours; a file with the same id replaces the shipped one
 *
 * On top of the profile, the user can force any module on or off. A module only really runs
 * when everything it requires runs too: turning the cluster off turns off what needs it, and
 * nothing is ever turned ON behind the user's back.
 */
const MODULES = [
  {
    id: 'docker', requires: [],
    label: { en: 'Docker engine', fr: 'Moteur Docker' },
    help: {
      en: 'Starts Docker when it is down, and shows whether the engine answers.',
      fr: 'Démarre Docker quand il est arrêté, et montre si le moteur répond.',
    },
  },
  {
    id: 'cluster', requires: ['docker'],
    label: { en: 'Local cluster', fr: 'Cluster local' },
    help: {
      en: 'k3d and the stack ArgoCD deploys in it: start, state of the pods, their logs.',
      fr: 'k3d et la stack qu\'ArgoCD y déploie : démarrage, état des pods, leurs journaux.',
    },
  },
  {
    id: 'network', requires: ['cluster'],
    label: { en: 'Network', fr: 'Réseau' },
    help: {
      en: 'Keeps this machine able to reach the cluster: the published ports and the hosts file.',
      fr: 'Garde cette machine capable de joindre le cluster : les conteneurs relais et le fichier hosts.',
    },
  },
  {
    id: 'horizon', requires: ['cluster'],
    label: { en: 'Horizon', fr: 'Horizon' },
    help: {
      en: 'Whether game clients can reach horizon, and the relay for another machine of the network.',
      fr: 'Si les clients du jeu peuvent joindre horizon, et le relais pour une autre machine du réseau.',
    },
  },
  {
    id: 'gameServer', requires: [],
    label: { en: 'Local game server', fr: 'Serveur de jeu local' },
    help: {
      en: 'Runs the game server from your sources instead of the cluster\'s own. For the cluster to '
        + 'use it, intercept the godotserver service with Telepresence (see the repository\'s README).',
      fr: 'Lance le serveur de jeu depuis tes sources au lieu de celui du cluster. Pour que le cluster '
        + 's\'en serve, intercepter le service godotserver avec Telepresence (voir le README du dépôt).',
    },
  },
  {
    id: 'telepresence', requires: ['cluster'],
    label: { en: 'Telepresence', fr: 'Telepresence' },
    help: {
      en: 'Connects this machine to the cluster and intercepts the game server: the documented way '
        + 'to make the cluster use a game server run from your sources.',
      fr: 'Connecte cette machine au cluster et intercepte le serveur de jeu : la voie prévue pour que '
        + 'le cluster se serve d\'un serveur de jeu lancé depuis tes sources.',
    },
  },
  {
    id: 'relink', requires: ['gameServer', 'horizon'],
    label: { en: 'Horizon ↔ local server link', fr: 'Lien horizon ↔ serveur local' },
    help: {
      en: 'Restarts horizon each time the local game server restarts, so the two stay connected.',
      fr: 'Redémarre horizon à chaque redémarrage du serveur de jeu local, pour que les deux restent reliés.',
    },
  },
  {
    id: 'clients', requires: [],
    label: { en: 'Game clients', fr: 'Clients du jeu' },
    help: {
      en: 'Launches game clients side by side, each logged in as a test player.',
      fr: 'Lance des clients du jeu côte à côte, chacun connecté comme un joueur de test.',
    },
  },
  {
    id: 'editor', requires: [],
    label: { en: 'Godot editor', fr: 'Éditeur Godot' },
    help: {
      en: 'Opens the game project in the editor and captures its output.',
      fr: 'Ouvre le projet du jeu dans l\'éditeur et capte sa sortie.',
    },
  },
  {
    id: 'npc', requires: ['cluster'],
    label: { en: 'NPC service', fr: 'Service PNJ' },
    help: {
      en: 'State of the NPC service and a button to restart it.',
      fr: 'État du service PNJ et un bouton pour le redémarrer.',
    },
  },
  {
    id: 'build', requires: ['cluster'],
    label: { en: 'Build an image', fr: 'Construire une image' },
    help: {
      en: 'Builds one service from its sources and runs it in the cluster (needs the service\'s repository).',
      fr: 'Bâtit un service depuis ses sources et le fait tourner dans le cluster (il faut le dépôt du service).',
    },
  },
  {
    id: 'danger', requires: ['cluster'],
    label: { en: 'Red zone', fr: 'Zone rouge' },
    help: {
      en: 'The irreversible actions: emptying the world\'s objects, deleting the cluster.',
      fr: 'Les actions irréversibles : vider les objets du monde, supprimer le cluster.',
    },
  },
];

/**
 * The sets of services a profile may ask the cluster to deploy: the directories of
 * argocd/dev/{infra,game,observability} in the repository (see "Service sets" in its README). `core` -- what Godot and
 * horizon need to run -- is always deployed and implied. Exactly one of `server` (the game server's own
 * image) and `server-idle` (a placeholder pod, for a server run from your sources behind a
 * Telepresence intercept) is deployed: `server` when the profile names neither.
 */
const SET_IDS = ['core', 'server', 'server-idle', 'gameplay', 'voice', 'admin', 'observability'];
/** Telepresence's traffic manager is part of `core` now; profiles of older versions may still name it. */
const LEGACY_SET_IDS = ['telepresence'];

const MODULE_IDS = MODULES.map((m) => m.id);
const BY_ID = new Map(MODULES.map((m) => [m.id, m]));

/**
 * Which modules really run.
 *
 * @param {object|null} profileModules  { id: bool } of the profile; null = no profile, everything on
 * @param {object} overrides            { id: bool } the user forced on or off
 * @returns {object} { id: { on, wanted, fromProfile, overridden, blockedBy: [ids] } }
 */
function resolveModules(profileModules, overrides = {}) {
  const out = {};
  const wantedOf = (id) => {
    const fromProfile = profileModules ? profileModules[id] === true : true;
    const overridden = typeof overrides[id] === 'boolean';
    return { fromProfile, overridden, wanted: overridden ? overrides[id] : fromProfile };
  };
  const visiting = new Set();
  const resolve = (id) => {
    if (out[id]) return out[id];
    const mod = BY_ID.get(id);
    const base = wantedOf(id);
    visiting.add(id);
    // Off when anything it needs is off. A cycle in the table would be a bug: treat it as blocked.
    const blockedBy = mod.requires.filter((req) => visiting.has(req) || !resolve(req).on);
    visiting.delete(id);
    out[id] = { ...base, blockedBy, on: base.wanted && blockedBy.length === 0 };
    return out[id];
  };
  for (const id of MODULE_IDS) resolve(id);
  return out;
}

/** Check a profile read from a file. Returns { ok, profile } or { ok: false, error }. */
function validateProfile(raw, fallbackId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not a JSON object' };
  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id || '')) return { ok: false, error: 'id must be lowercase letters, digits and dashes' };
  if (!raw.modules || typeof raw.modules !== 'object') return { ok: false, error: 'missing "modules"' };
  const modules = {};
  for (const [key, value] of Object.entries(raw.modules)) {
    if (!BY_ID.has(key)) return { ok: false, error: 'unknown module "' + key + '"' };
    if (typeof value !== 'boolean') return { ok: false, error: 'module "' + key + '" must be true or false' };
    modules[key] = value;
  }
  // `sets` is optional: absent means every set, which is what start-dev did before sets existed.
  let sets = null;
  if (raw.sets !== undefined) {
    if (!Array.isArray(raw.sets)) return { ok: false, error: '"sets" must be a list' };
    for (const name of raw.sets) {
      if (!SET_IDS.includes(name) && !LEGACY_SET_IDS.includes(name)) return { ok: false, error: 'unknown set "' + name + '" (' + SET_IDS.join(', ') + ')' };
    }
    if (raw.sets.includes('server') && raw.sets.includes('server-idle')) {
      return { ok: false, error: '"server" and "server-idle" are exclusive' };
    }
    sets = SET_IDS.filter((name) => name === 'core' || raw.sets.includes(name));
    if (!sets.includes('server') && !sets.includes('server-idle')) sets.splice(1, 0, 'server');
  }
  const text = (t) => (t && typeof t === 'object' ? { en: String(t.en || t.fr || id), fr: String(t.fr || t.en || id) } : { en: id, fr: id });
  return {
    ok: true,
    profile: {
      id,
      name: text(raw.name),
      description: raw.description ? text(raw.description) : { en: '', fr: '' },
      modules,
      sets,
      settings: raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) ? raw.settings : {},
    },
  };
}

/**
 * Read every profile: the shipped ones, then the user's (same id = replaces).
 * @returns {object} { profiles: Map<id, profile>, problems: [message] }
 */
function loadProfiles(dirs) {
  const profiles = new Map();
  const problems = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        let textRaw = fs.readFileSync(file, 'utf8');
        if (textRaw.charCodeAt(0) === 0xFEFF) textRaw = textRaw.slice(1);
        const checked = validateProfile(JSON.parse(textRaw), path.basename(name, '.json'));
        if (!checked.ok) {
          problems.push('profile ' + file + ' ignored: ' + checked.error);
          continue;
        }
        profiles.set(checked.profile.id, { ...checked.profile, file });
      } catch (err) {
        problems.push('profile ' + file + ' ignored: ' + String(err && err.message));
      }
    }
  }
  return { profiles, problems };
}

module.exports = { MODULES, MODULE_IDS, SET_IDS, resolveModules, validateProfile, loadProfiles };
