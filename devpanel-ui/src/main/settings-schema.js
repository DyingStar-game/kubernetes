'use strict';

/**
 * Every setting of the panel, declared once.
 *
 * This list is the single source of truth: the defaults, the validation of config.json AND the
 * settings screen are all derived from it. Adding a setting is adding one entry here -- no form
 * to write, no default file to keep in step.
 *
 * An entry:
 *   key        dotted path in the configuration ("paths.godotExe")
 *   type       file | directory | string | number | bool | list | enum
 *   section    where it shows in the settings screen (see SECTIONS)
 *   default    the value when the user set nothing; either a plain value or
 *              { win32: ..., linux: ... } when it differs per system
 *   label      { en, fr } short name
 *   help       { en, fr } one or two sentences: what it is, and what happens when it is wrong
 *   required   the panel cannot do its main job without it (the screen opens by itself)
 *   detect     name of a detector in detect.js that can propose a value when none is set
 *   restart    true when a change only applies after restarting the panel
 *   platforms  restrict the entry to some systems
 *   options    for enum: the allowed values
 *   min, max   for number
 *   advanced   shown folded: nobody should need it on a normal day
 *
 * No value here may be specific to one person's machine: the test suite checks it.
 */

const SECTIONS = [
  { id: 'general', label: { en: 'General', fr: 'Général' } },
  { id: 'workspace', label: { en: 'Repositories', fr: 'Dépôts' } },
  { id: 'godot', label: { en: 'Godot', fr: 'Godot' } },
  { id: 'cluster', label: { en: 'Cluster', fr: 'Cluster' } },
  { id: 'network', label: { en: 'Network and accounts', fr: 'Réseau et comptes' } },
  { id: 'logs', label: { en: 'Logs and local API', fr: 'Journaux et API locale' } },
  { id: 'timeouts', label: { en: 'Timeouts', fr: 'Délais' } },
];

const SCHEMA = [
  // ── general ─────────────────────────────────────────────────────────────
  {
    key: 'ui.language', type: 'enum', section: 'general', options: ['en', 'fr'], default: 'en',
    detect: 'language', restart: true,
    label: { en: 'Language', fr: 'Langue' },
    help: {
      en: 'Language of the interface.',
      fr: "Langue de l'interface.",
    },
  },

  // ── repositories ────────────────────────────────────────────────────────
  {
    key: 'paths.workspace', type: 'directory', section: 'workspace', default: '', detect: 'workspace',
    label: { en: 'Workspace folder', fr: 'Dossier de travail' },
    help: {
      en: 'The folder that holds the repositories and Godot, side by side. The setup assistant clones '
        + 'and downloads into it, and the panel looks in it for what is not set below.',
      fr: 'Le dossier qui contient les dépôts et Godot, côte à côte. L\'assistant d\'installation y clone '
        + 'et y télécharge, et le panneau y cherche ce qui n\'est pas renseigné ci-dessous.',
    },
  },
  {
    key: 'paths.kubernetesRepo', type: 'directory', section: 'workspace', default: '',
    required: true, detect: 'kubernetesRepo',
    label: { en: 'kubernetes repository', fr: 'Dépôt kubernetes' },
    help: {
      en: 'Your clone of the kubernetes repository. The panel runs its scripts (start-dev, '
        + 'build-and-deploy...) and reads dev-projects.yaml from it. It is also the folder ArgoCD reads.',
      fr: 'Ton clone du dépôt kubernetes. Le panneau lance ses scripts (start-dev, build-and-deploy…) '
        + "et y lit dev-projects.yaml. C'est aussi le dossier qu'ArgoCD lit.",
    },
  },
  {
    key: 'paths.godotProject', type: 'directory', section: 'workspace', default: '',
    required: true, detect: 'godotProject',
    label: { en: 'Game project', fr: 'Projet du jeu' },
    help: {
      en: 'The folder of the game sources, the one that holds project.godot.',
      fr: 'Le dossier des sources du jeu, celui qui contient project.godot.',
    },
  },

  // ── godot ───────────────────────────────────────────────────────────────
  {
    key: 'paths.godotExe', type: 'file', section: 'godot', default: '',
    required: true, detect: 'godotExe',
    label: { en: 'Godot executable', fr: 'Exécutable Godot' },
    help: {
      en: 'The project\'s own Godot build (mono, double precision), not the one from godotengine.org. '
        + 'On Windows pick the "_console" executable: it is the one whose output can be read.',
      fr: 'Le Godot du projet (mono, double précision), pas celui de godotengine.org. '
        + 'Sous Windows, choisir l\'exécutable « _console » : c\'est celui dont on peut lire la sortie.',
    },
  },
  {
    key: 'paths.godotSharpNupkgs', type: 'directory', section: 'godot', default: '',
    detect: 'godotSharpNupkgs',
    label: { en: 'C# packages (nupkgs)', fr: 'Paquets C# (nupkgs)' },
    help: {
      en: 'The GodotSharp/Tools/nupkgs folder of that same Godot. The C# packages must come from the '
        + 'double-precision build: the ones from nuget.org crash at runtime.',
      fr: 'Le dossier GodotSharp/Tools/nupkgs de ce même Godot. Les paquets C# doivent venir du build '
        + 'double précision : ceux de nuget.org plantent au lancement.',
    },
  },
  {
    key: 'godot.clientCount', type: 'number', section: 'godot', default: 2, min: 1, max: 8,
    label: { en: 'Clients to launch', fr: 'Clients à lancer' },
    help: {
      en: 'How many game clients "Launch the clients" starts by default.',
      fr: 'Combien de clients « Lancer les clients » démarre par défaut.',
    },
  },
  {
    key: 'godot.clientWidth', type: 'number', section: 'godot', default: 1280, min: 320, max: 7680,
    label: { en: 'Client window width', fr: 'Largeur de la fenêtre client' },
    help: {
      en: 'Clients are placed side by side: the second one starts this many pixels to the right.',
      fr: 'Les clients sont rangés côte à côte : le deuxième démarre ce nombre de pixels plus à droite.',
    },
  },
  {
    key: 'godot.clientHeight', type: 'number', section: 'godot', default: 720, min: 240, max: 4320,
    label: { en: 'Client window height', fr: 'Hauteur de la fenêtre client' },
    help: { en: 'Height of each client window, in pixels.', fr: 'Hauteur de chaque fenêtre client, en pixels.' },
  },
  {
    key: 'godot.clientArgs', type: 'list', section: 'godot', default: [], advanced: true,
    label: { en: 'Extra client arguments', fr: 'Arguments client en plus' },
    help: {
      en: 'Added to the command line of every client, one per line.',
      fr: 'Ajoutés à la ligne de commande de chaque client, un par ligne.',
    },
  },
  {
    key: 'godot.serverArgs', type: 'list', section: 'godot', default: ['--srvini=test/ini/srv1.ini'],
    advanced: true,
    label: { en: 'Local server arguments', fr: 'Arguments du serveur local' },
    help: {
      en: 'Command line of the local dedicated server, one argument per line. The ini file decides '
        + 'its port and which services it talks to.',
      fr: 'Ligne de commande du serveur dédié local, un argument par ligne. Le fichier ini fixe son '
        + 'port et les services auxquels il parle.',
    },
  },
  {
    key: 'godot.serverFeatures', type: 'string', section: 'godot', default: 'dedicated_server',
    advanced: true,
    label: { en: 'Local server feature tags', fr: 'Balises du serveur local' },
    help: {
      en: 'Godot feature tags given to the local server, as the editor\'s "Run Instances" would.',
      fr: 'Balises de fonctionnalités Godot données au serveur local, comme le ferait « Run Instances » de l\'éditeur.',
    },
  },
  {
    key: 'stream.tilesUrl', type: 'string', section: 'godot',
    default: 'https://planettech.dyingstar-game.space', advanced: true,
    label: { en: 'Terrain tile server', fr: 'Serveur de tuiles de terrain' },
    help: {
      en: 'Where the local server fetches its elevation tiles. Without it the terrain collision is '
        + 'built from a coarse map and players fall through the ground.',
      fr: 'Où le serveur local va chercher ses tuiles d\'altitude. Sans lui, la collision du terrain '
        + 'est bâtie sur une carte grossière et les joueurs passent à travers le sol.',
    },
  },
  {
    key: 'stream.channel', type: 'string', section: 'godot', default: 'dev', advanced: true,
    label: { en: 'Tile channel', fr: 'Canal des tuiles' },
    help: { en: 'Which published set of tiles to use.', fr: 'Quel jeu de tuiles publié utiliser.' },
  },

  // ── cluster ─────────────────────────────────────────────────────────────
  {
    key: 'paths.dockerDesktop', type: 'file', section: 'cluster', default: '', platforms: ['win32'],
    detect: 'dockerDesktop',
    label: { en: 'Docker Desktop', fr: 'Docker Desktop' },
    help: {
      en: 'The Docker Desktop program, so "Start everything" can launch it when the engine is down.',
      fr: 'Le programme Docker Desktop, pour que « Tout démarrer » puisse le lancer quand le moteur est arrêté.',
    },
  },
  {
    key: 'paths.dockerStartCommand', type: 'string', section: 'cluster', default: '', platforms: ['linux'],
    label: { en: 'Command that starts Docker', fr: 'Commande qui démarre Docker' },
    help: {
      en: 'Only if "systemctl --user start docker-desktop" is not how Docker starts on your system. '
        + 'The panel never calls sudo.',
      fr: 'Seulement si « systemctl --user start docker-desktop » n\'est pas la bonne façon chez toi. '
        + 'Le panneau n\'appelle jamais sudo.',
    },
  },
  {
    key: 'k8s.namespace', type: 'string', section: 'cluster', default: 'dyingstar', restart: true,
    pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$',
    label: { en: 'Namespace', fr: 'Namespace' },
    help: {
      en: 'The Kubernetes namespace of the game stack.',
      fr: 'Le namespace Kubernetes de la stack du jeu.',
    },
  },
  {
    key: 'k8s.expectedContext', type: 'string', section: 'cluster', default: 'minikube', advanced: true,
    label: { en: 'Kube context', fr: 'Contexte kube' },
    help: {
      en: 'The context kubectl must be on. A guard: the panel never acts on another cluster.',
      fr: 'Le contexte sur lequel kubectl doit être. Un garde-fou : le panneau n\'agit jamais sur un autre cluster.',
    },
  },
  {
    key: 'k8s.horizonDeployment', type: 'string', section: 'cluster', default: 'horizon', advanced: true,
    label: { en: 'Horizon deployment', fr: 'Déploiement horizon' },
    help: { en: 'Name of the horizon Deployment and Service.', fr: 'Nom du Deployment et du Service horizon.' },
  },
  {
    key: 'k8s.scyllaKeyspace', type: 'string', section: 'cluster', default: 'dyingstar', advanced: true,
    pattern: '^[A-Za-z0-9_]+$',
    label: { en: 'ScyllaDB keyspace', fr: 'Keyspace ScyllaDB' },
    help: {
      en: 'Keyspace emptied by "Purge ScyllaDB".',
      fr: 'Keyspace vidé par « Purger ScyllaDB ».',
    },
  },
  {
    key: 'minikube.startArgs', type: 'list', section: 'cluster', default: ['start'], advanced: true,
    label: { en: 'minikube arguments', fr: 'Arguments de minikube' },
    help: {
      en: 'How the panel restarts an EXISTING cluster, one argument per line. Creating a cluster is '
        + 'the job of the repository\'s start-dev script.',
      fr: 'Comment le panneau relance un cluster EXISTANT, un argument par ligne. Créer un cluster '
        + 'est le travail du script start-dev du dépôt.',
    },
  },

  // ── network and accounts ────────────────────────────────────────────────
  {
    key: 'network.mode', type: 'enum', section: 'network', options: ['relays', 'tunnel'], default: 'relays',
    label: { en: 'Network path', fr: 'Chemin réseau' },
    help: {
      en: 'How this machine reaches the cluster. "relays": the hosts file points at 127.0.0.1 (written '
        + 'once) and small relay containers forward to the cluster, with no console to keep open. '
        + '"tunnel": the repository\'s way, minikube tunnel in an administrator console left open by '
        + 'start-dev. The two cannot run together.',
      fr: 'Comment cette machine joint le cluster. « relays » : le fichier hosts pointe sur 127.0.0.1 '
        + '(écrit une fois) et de petits conteneurs relais font suivre vers le cluster, sans console à '
        + 'garder ouverte. « tunnel » : la façon du dépôt, minikube tunnel dans une console '
        + 'administrateur laissée ouverte par start-dev. Les deux ne peuvent pas tourner ensemble.',
    },
  },
  {
    key: 'ports.gameServer', type: 'number', section: 'network', default: 8980, min: 1, max: 65535,
    label: { en: 'Local game server port', fr: 'Port du serveur de jeu local' },
    help: {
      en: 'TCP port the local dedicated server listens on (set by its ini file).',
      fr: 'Port TCP sur lequel écoute le serveur dédié local (fixé par son fichier ini).',
    },
  },
  {
    key: 'ports.horizon', type: 'number', section: 'network', default: 7040, min: 1, max: 65535,
    label: { en: 'Horizon relay port', fr: 'Port du relais horizon' },
    help: {
      en: 'Local port of the "Horizon relay" button (expose-horizon).',
      fr: 'Port local du bouton « Relais horizon » (expose-horizon).',
    },
  },
  {
    key: 'k8s.horizonHost', type: 'string', section: 'network', default: 'horizon.dyingstar.local',
    advanced: true,
    label: { en: 'Horizon host name', fr: 'Nom d\'hôte d\'horizon' },
    help: {
      en: 'The name the ingress serves horizon under.',
      fr: 'Le nom sous lequel l\'ingress sert horizon.',
    },
  },
  {
    key: 'auth.playerTokens', type: 'bool', section: 'network', default: true,
    label: { en: 'Log clients in as test players', fr: 'Connecter les clients en joueurs de test' },
    help: {
      en: 'Each client the panel launches gets a token for one of the dev realm\'s test accounts. '
        + 'Without a token the in-game services answer 401 and their screens stay empty.',
      fr: 'Chaque client lancé par le panneau reçoit un jeton pour un des comptes de test du royaume '
        + 'de dev. Sans jeton, les services du jeu répondent 401 et leurs écrans restent vides.',
    },
  },
  {
    key: 'auth.tokenUrl', type: 'string', section: 'network', advanced: true,
    default: 'http://auth.dyingstar.local/realms/dyingstar/protocol/openid-connect/token',
    label: { en: 'Token endpoint', fr: 'Adresse des jetons' },
    help: {
      en: 'Token endpoint of the dev Keycloak realm.',
      fr: 'Adresse de délivrance des jetons du royaume Keycloak de dev.',
    },
  },
  {
    key: 'auth.clientId', type: 'string', section: 'network', default: 'dyingstar-dev', advanced: true,
    label: { en: 'Keycloak client', fr: 'Client Keycloak' },
    help: {
      en: 'The public client of the dev realm made for test logins.',
      fr: 'Le client public du royaume de dev prévu pour les connexions de test.',
    },
  },

  // ── logs and local API ──────────────────────────────────────────────────
  {
    key: 'logs.clearOnRestart', type: 'bool', section: 'logs', default: true,
    label: { en: 'Clear a log when its process restarts', fr: 'Vider un journal quand son processus redémarre' },
    help: {
      en: 'A tab then shows only the last run. The .log files keep everything.',
      fr: 'Un onglet ne montre alors que le dernier lancement. Les fichiers .log gardent tout.',
    },
  },
  {
    key: 'logs.maxLines', type: 'number', section: 'logs', default: 120000, min: 1000, max: 2000000,
    restart: true, advanced: true,
    label: { en: 'Lines kept in memory', fr: 'Lignes gardées en mémoire' },
    help: {
      en: 'Size of the searchable buffer. Older lines stay in the .log files.',
      fr: 'Taille du tampon de recherche. Les lignes plus anciennes restent dans les fichiers .log.',
    },
  },
  {
    key: 'logs.rendererMaxLines', type: 'number', section: 'logs', default: 60000, min: 1000, max: 500000,
    advanced: true,
    label: { en: 'Lines sent to the window', fr: 'Lignes envoyées à la fenêtre' },
    help: {
      en: 'How much history the window gets back after a reload.',
      fr: 'Combien d\'historique la fenêtre récupère après un rechargement.',
    },
  },
  {
    key: 'api.enabled', type: 'bool', section: 'logs', default: true, restart: true,
    label: { en: 'Local API', fr: 'API locale' },
    help: {
      en: 'A small HTTP API on this machine only (127.0.0.1): scripts and assistants read the state '
        + 'and search the logs through it. Actions need the token kept in the data folder.',
      fr: 'Une petite API HTTP sur cette machine seulement (127.0.0.1) : scripts et assistants y lisent '
        + 'l\'état et cherchent dans les journaux. Les actions exigent le jeton rangé dans le dossier de données.',
    },
  },
  {
    key: 'ports.api', type: 'number', section: 'logs', default: 7788, min: 1024, max: 65535, restart: true,
    label: { en: 'Local API port', fr: 'Port de l\'API locale' },
    help: { en: 'TCP port of the local API.', fr: 'Port TCP de l\'API locale.' },
  },
  {
    key: 'dev.hotReloadRenderer', type: 'bool', section: 'logs', default: true, restart: true, advanced: true,
    label: { en: 'Reload the interface when its files change', fr: 'Recharger l\'interface quand ses fichiers changent' },
    help: {
      en: 'For working on the panel itself, run from its sources. Ignored by an installed panel.',
      fr: 'Pour travailler sur le panneau lui-même, lancé depuis ses sources. Ignoré par un panneau installé.',
    },
  },

  // ── timeouts ────────────────────────────────────────────────────────────
  ...[
    ['timeouts.dockerReadyMs', 240000, 'Docker engine', 'Moteur Docker'],
    ['timeouts.minikubeReadyMs', 300000, 'minikube', 'minikube'],
    ['timeouts.stackReadyMs', 900000, 'k8s stack', 'Stack k8s'],
    ['timeouts.gameServerReadyMs', 300000, 'Local game server', 'Serveur de jeu local'],
    ['timeouts.relinkMs', 180000, 'Horizon link', 'Lien horizon'],
    ['timeouts.worldDeliveryMs', 120000, 'World delivery', 'Livraison du monde'],
    ['timeouts.serverSettleMs', 240000, 'Game server loading', 'Chargement du serveur de jeu'],
  ].map(([key, value, en, fr]) => ({
    key, type: 'number', section: 'timeouts', default: value, min: 1000, max: 3600000, advanced: true,
    label: { en, fr },
    help: {
      en: 'How long the panel waits for it, in milliseconds, before calling the step failed.',
      fr: 'Combien de temps le panneau l\'attend, en millisecondes, avant de déclarer l\'étape en échec.',
    },
  })),
  {
    key: 'relink.graceMs', type: 'number', section: 'timeouts', default: 45000, min: 0, max: 600000,
    advanced: true,
    label: { en: 'Time left to horizon to reconnect', fr: 'Délai laissé à horizon pour se reconnecter' },
    help: {
      en: 'Horizon finds a restarted game server again by itself. Only after this long without a link, '
        + 'in milliseconds, does the panel restart horizon. 0 restarts it at once, as it used to.',
      fr: 'Horizon retrouve tout seul un serveur de jeu redémarré. Ce n\'est qu\'après ce délai sans lien, '
        + 'en millisecondes, que le panneau redémarre horizon. 0 le redémarre tout de suite, comme avant.',
    },
  },
  {
    key: 'relink.maxAttempts', type: 'number', section: 'timeouts', default: 1, min: 1, max: 5, advanced: true,
    label: { en: 'Relink attempts', fr: 'Tentatives de relink' },
    help: {
      en: 'Each extra attempt delivers the whole world again to a server that may already hold it. Leave at 1.',
      fr: 'Chaque tentative en plus relivre le monde entier à un serveur qui l\'a peut-être déjà. Laisser à 1.',
    },
  },
  {
    key: 'relink.maxConsecutiveFailures', type: 'number', section: 'timeouts', default: 2, min: 1, max: 20,
    advanced: true,
    label: { en: 'Relink failures before giving up', fr: 'Échecs de relink avant abandon' },
    help: {
      en: 'After this many failed relinks in a row the watcher stops instead of restarting horizon forever.',
      fr: 'Après ce nombre d\'échecs d\'affilée, le veilleur s\'arrête au lieu de redémarrer horizon sans fin.',
    },
  },
];

/** Keys older versions wrote that mean nothing any more: dropped when a config is imported. */
const DEAD_KEYS = [
  'paths.gitBash', 'paths.bash', 'paths.devShCwdPosix', 'paths.horizonserverRepo',
  'k8s.traefikNamespace', 'k8s.argoNamespace', 'api.host', 'npc',
  'timeouts.serverQuietMs',
];

/** Keys that changed name: { old: new }. */
const RENAMED_KEYS = {
  'timeouts.skaffoldReadyMs': 'timeouts.stackReadyMs',
};

/** Top-level keys that are not settings but belong in config.json. */
const RESERVED_KEYS = ['configVersion', 'profile', 'modules'];

const CONFIG_VERSION = 2;

module.exports = { SECTIONS, SCHEMA, DEAD_KEYS, RENAMED_KEYS, RESERVED_KEYS, CONFIG_VERSION };
