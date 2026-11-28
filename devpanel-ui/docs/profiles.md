# Profiles, modules, settings, texts: how to extend the panel

Four things can be added without touching the core of the panel. Each is data, checked by a test.

| To add | Edit | Checked by |
|---|---|---|
| a profile | one JSON file | `tools/test-modules.js` |
| a module | `src/main/modules.js` + where it shows | `tools/test-modules.js` |
| a setting | `src/main/settings-schema.js` | `tools/test-settings.js` |
| a text | `src/i18n/en.json` and `fr.json` | `tools/test-i18n.js` |

Run `npm test` after any of them.

## A profile

A profile says which modules a kind of user gets, and which **sets of services** the local
cluster deploys. The modules change what the panel shows, watches and starts; the sets change what
`start-dev` deploys (see "Service sets" in the repository's README).

```json
{
  "id": "level-designer",
  "version": 1,
  "name": { "en": "Level designer", "fr": "Level designer" },
  "description": { "en": "Only the editor and the game clients.", "fr": "Seulement l'éditeur et les clients." },
  "modules": {
    "docker": false, "cluster": false, "network": false, "horizon": false, "gameServer": false,
    "telepresence": false,
    "relink": false,
    "clients": true, "editor": true, "npc": false, "build": false, "danger": false
  },
  "sets": ["gameplay"],
  "settings": { "godot": { "clientCount": 1 } }
}
```

- `modules`: `true` or `false` for each module. A module only runs when what it requires runs
  too (see the table below); a shipped profile must not ask for a module it blocks.
- `sets`: optional. The service sets to deploy besides `core`, which is always there (what Godot and
  horizon need to run): `gameplay`, `voice` (LiveKit, proximity voice), `admin`, `observability`. The Telepresence traffic manager is part of `core`. One game server set is always deployed: `server` (the real image, the default) or `server-idle` (a tiny placeholder pod instead of the Godot image, for a server run from your sources behind a Telepresence intercept; saves ~1 Gi). `[]` is the minimum,
  for people who only need the game to run. Absent means every set except `observability` (heavy, ~1.5 Gi). It only applies when the panel starts the stack;
  a running cluster is changed with `scripts_*/sets-dev`.
- `settings`: optional. Any setting of the settings screen, as the profile's preference. The
  user's own choice still wins.
- `name`, `description`: shown in the settings screen. One language is enough for a personal
  profile; shipped ones have both.

Where the file goes:

- `profiles/<id>.json` in the panel's folder: shipped with it, for everyone.
- `profiles/<id>.json` in your data folder (the settings screen shows the exact path): yours.
  A file with the id of a shipped profile replaces it, which is the quick way to try a change
  without rebuilding anything. A file with a mistake is ignored and the reason is written to
  the `panel` log tab.

The user picks a profile in the settings screen and can still tick or untick single modules on
top of it. With no profile chosen, every module is on.

## The modules

| id | What it covers | Requires |
|---|---|---|
| `docker` | starting Docker, its light and its step | – |
| `cluster` | minikube, the kube context, the stack; the pods and their logs | `docker` |
| `network` | the relay containers and the hosts file that let this machine reach the cluster | `cluster` |
| `horizon` | whether clients can reach horizon; the relay | `cluster` |
| `gameServer` | a game server run from your sources | – |
| `telepresence` | connecting to the cluster and intercepting the game server | `cluster` |
| `relink` | keeping horizon linked to that local server | `gameServer`, `horizon` |
| `clients` | launching game clients | – |
| `editor` | the Godot editor | – |
| `npc` | the NPC service's light and restart button | `cluster` |
| `build` | building one image from its sources | `cluster` |
| `danger` | the irreversible actions | `cluster` |

A module that is off is gone everywhere at once: its cards, its lights, its steps of the start
chain, its health checks (nothing is even probed), and its actions, which the main process
refuses for the window and for the local API alike (`code: "module-disabled"`).

### Adding a module

1. Declare it in `MODULES` (`src/main/modules.js`): `id`, `requires`, `label` and `help` in
   English and French.
2. Tag what belongs to it:
   - in the page (`src/renderer/index.html`): `data-module="<id>"` on its card or on a single
     element. Several ids, space separated, keep the element while any of them is on;
   - a status light: its entry in the list built in `renderState` (`src/renderer/app.js`);
   - a step of the start chain: `module` in `STEPS` (`src/main/services.js`), and guard its
     part of `startAll` with `this._on('<id>')`;
   - a health check: skip it in `Probes.all` (`src/main/probes.js`) when the module is off;
   - its actions: `ACTION_MODULE` in `src/main/main.js`.
3. Say whether each shipped profile has it (`profiles/*.json` list every module).

## A setting

One entry in `SCHEMA` (`src/main/settings-schema.js`). The settings screen, the defaults and
the validation of `config.json` all come from it:

```js
{
  key: 'godot.clientCount', type: 'number', section: 'godot', default: 2, min: 1, max: 8,
  label: { en: 'Clients to launch', fr: 'Clients à lancer' },
  help: { en: '…', fr: '…' },
}
```

Types: `file`, `directory`, `string`, `number`, `bool`, `list`, `enum`. Useful extras:
`required` (the screen opens by itself when it is missing), `detect` (a detector of
`src/main/detect.js` proposes a value), `restart` (only applies after a restart), `platforms`
(`['win32']` or `['linux']`), `advanced` (folded away). Read the value in the main process as
`config.<key>`; it is updated in place when the user changes it.

A default must never be tied to one machine: no absolute path, no home folder. Something that
differs per machine is found by a detector, not written as a default.

## A text

Everything the window shows is in `src/i18n/en.json` and `src/i18n/fr.json`, same keys in both.

- In the page: `data-i18n="key"` (text), `data-i18n-title="key"` (tooltip),
  `data-i18n-placeholder="key"`, or `data-i18n-html="key"` for the few texts with markup.
- In the scripts: `t('key')`, or `t('key', { name: value })` for a text with `{name}` in it.

What goes to the log is not translated: the log is English, always. It is searched, pasted into
bug reports and read by scripts.
