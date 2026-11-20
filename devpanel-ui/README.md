# DyingStar dev panel

One window to run the local development stack: start everything in the right order, see every
log in one place, and search them while they scroll.

It drives the scripts of this repository (`scripts_windows/`, `scripts_linux/`); it does not
replace them. Windows and Linux.

> Status: early. The panel started as one developer's tool and is being opened up. The Linux
> side is covered by tests but has had little use on real machines: reports are welcome.

New to the project? [docs/getting-started.md](docs/getting-started.md) goes from an empty
machine to the game world, step by step ([en français](docs/demarrer.fr.md)).

## Run it

**Installed.** Take the file for your system from this repository's Releases page: a Windows
installer, or an AppImage, a `.deb` or a `.rpm` for Linux. They are not signed: on first run
Windows shows "Windows protected your PC" (*More info*, then *Run anyway*). `SHA256SUMS` on the
same page lets you check a download.

**From the sources** (nothing to compile, the panel is plain JavaScript):

```bash
cd devpanel-ui
npm ci        # downloads Electron for your system
npm start
```

Node.js 20 or newer. Editing a file under `src/renderer/` reloads the window by itself; a change
under `src/main/` needs the panel restarted (it says so).

## Settings

The gear at the top right. Nothing has to be edited by hand.

On a standard checkout nothing has to be typed either: the panel looks around itself for

| What | Where | Recognised by |
|---|---|---|
| the kubernetes repository | its parent folder, or a `kubernetes` folder next to it | `dev-projects.yaml` |
| the game project | the folders next to that repository | `project.godot` |
| Godot | a `Godot…` folder next to the repositories | a `Godot_v…mono…` executable |
| the C# packages | next to that executable | `GodotSharp/Tools/nupkgs` |
| Docker Desktop (Windows) | its standard install folder | the executable |

A detected value is a suggestion: it is shown as *detected*, it is never written anywhere, and
whatever you choose yourself wins. The screen opens by itself when something required could not
be found.

Everything you set is kept in one folder, together with the logs and the local API token:

| System | Data folder |
|---|---|
| Windows | `%APPDATA%\dyingstar-devpanel` |
| Linux | `~/.config/dyingstar-devpanel` |

`config.json` in there only holds what you changed. Two launch options move that folder, which
is also how two panels run side by side:

```bash
npm start -- --data-dir=/some/other/folder     # or the DS_DEVPANEL_DATA_DIR variable
```

## What it does

**The start chain.** "Start everything" brings up, in order, the Docker engine, the minikube
cluster, the kube context, the stack (ArgoCD keeps it deployed, so most days there is nothing to
start) and, if you use one, the local game server and its link to horizon. Each step waits for
the thing that matters, not for a command to return: `minikube start` exiting does not mean the
API server answers.

**Logs.** Every pod and every process the panel starts gets a tab. The search works while the
logs scroll (plain text or regular expression, filter or highlight, by level). The same lines go
to one `.log` file per source in the data folder; the previous session's files are kept in
`logs/previous/`.

**Buttons for the usual gestures.** Restart a pod, rebuild one image from its sources
(`build-and-deploy`, the targets of `dev-projects.yaml`), open the horizon relay
(`expose-horizon`), launch the editor or a few game clients side by side, each logged in as one
of the dev realm's test players.

**A local game server (optional).** By default horizon talks to the game-server pod of the
cluster. To run the game server from your sources instead, connect Telepresence and intercept
the `godotserver` service (`telepresence connect --namespace dyingstar`, then
`telepresence intercept godotserver --port 8980`; see "Develop godot server with cluster APIs"
in the main README). The panel can then start that server and keep horizon linked to it: horizon connects to the game server once,
at its own start, so every server restart needs horizon restarted after it. The "relink"
watcher does exactly that, and refuses to do it twice in a row onto a server that already
received the world.

**The red zone.** Emptying the persisted world objects, and deleting the cluster. Deleting the
cluster destroys every database in it: the button asks for the cluster's name.

## Local API

For scripts and assistants, on this machine only (`127.0.0.1`, port 7788 by default; it can be
turned off in the settings).

```bash
curl http://127.0.0.1:7788/api                 # the list of routes and actions
curl http://127.0.0.1:7788/api/state
curl "http://127.0.0.1:7788/api/logs?source=horizon&q=ERROR&limit=200"
curl "http://127.0.0.1:7788/api/logs?level=ERROR,WARN&regex=1&q=spawn.*fail"
curl "http://127.0.0.1:7788/api/tail?source=godot-server&n=100"
```

Reading is open. Actions need the token the panel writes at each start to
`runtime/api-token.txt` in the data folder (`/api/state` gives that folder as `config.dataDir`):

```bash
curl -X POST http://127.0.0.1:7788/api/action \
  -H "x-devpanel-token: $(cat <data folder>/runtime/api-token.txt)" \
  -H "content-type: application/json" -d '{"action":"relink-now"}'
```

Tokens are masked in everything the panel logs.

## Working on the panel

```
src/main/               the main process
  settings-schema.js    every setting, declared once (defaults, validation, the settings screen)
  config.js  detect.js  the configuration store; what can be found without asking
  services.js           the start chain
  probes.js             the read-only health checks behind the lights
  platform/             the ONLY code that knows the operating system (win32.js, linux.js)
  api.js  logbus.js  procman.js  podlogs.js  godot.js  k8s.js  relink.js
src/renderer/           the window: plain HTML, CSS and JavaScript, no build step
tools/                  the tests
```

- **A new setting** is one entry in `settings-schema.js`, with its label and help in English and
  French. The settings screen and the validation follow.
- **Something that differs between systems** goes in `platform/`, in both files.
- **Tests**: `npm test` (plain Node, no framework). The Linux platform tests only run on Linux:
  `docker run --rm -v "$PWD":/app -w /app node:22-alpine node tools/test-linux-platform.js`.
- **Looking at the window without disturbing a running panel**:
  `npm start -- --data-dir=/tmp/panel-test --smoke-test --screenshot=/tmp/panel.png`
  loads the window, saves a picture of it and exits (`--open=settings` starts on that screen).

- **Installers**: `npm run dist` builds the one for the system you are on, into `dist/`
  (`npm run pack` stops at the unpacked folder, quicker to try). A release is a tag named
  `devpanel-vX.Y.Z`, matching the version in `package.json`: the workflow builds for Windows and
  Linux and publishes on the Releases page.
- **Extending it** (a profile, a module, a setting, a text): [docs/profiles.md](docs/profiles.md).

Three behaviours are deliberate; please do not "fix" them:

1. **Stopping a process kills its tree, hard.** The panel means "stop this process", never
   "undo what it deployed".
2. **Restarting a deployment deletes its pods** instead of `kubectl rollout restart`: the latter
   edits the Deployment, ArgoCD reverts the edit, and the pod restarts twice.
3. **"Kill ghost servers" spares what the panel started.** Its own game server is headless too.

## Licence

GNU Affero General Public License v3.0, like the game. See [LICENSE](LICENSE).
