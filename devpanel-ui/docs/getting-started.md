# Installing everything from scratch

This guide starts from a machine with **nothing** installed and takes you all the way into the
game world, on your own machine. Allow a good hour, most of it waiting for downloads.

You do not need to know anything about Docker or Kubernetes: the panel does the work, and this
guide tells you what each thing means.

*Version française : [demarrer.fr.md](demarrer.fr.md).*

## What you need

| | Minimum | Comfortable |
|---|---|---|
| Memory | 16 GB | 32 GB |
| Free disk | 40 GB | 80 GB |
| System | Windows 10 or 11, or a recent Linux | |

With less than 16 GB the whole stack will not fit: talk to the team, there is a profile without
a local cluster (editor and clients only).

## 1. Install the panel

1. Go to the **Releases** page of the `kubernetes` repository and take the file for your system:
   - Windows: `…-Setup-….exe`;
   - Linux: `.AppImage` (any distribution), `.deb` (Debian, Ubuntu) or `.rpm` (Fedora).
2. Run it.
   - **Windows shows "Windows protected your PC"**: expected, the program is not signed. Click
     *More info*, then *Run anyway*.
   - AppImage: make the file executable (`chmod +x`), then run it. If nothing happens on a recent
     Ubuntu/Debian, install FUSE 2 (`sudo apt install libfuse2`, `libfuse2t64` on Ubuntu 24.04).
     If it stops with a "sandbox" error (Ubuntu 24.04 restricts user namespaces), use the `.deb`
     instead, which installs the sandbox helper properly.

> As long as no version is published on the Releases page, start from the sources (below).

From the sources: `git clone` the `kubernetes` repository, then in `devpanel-ui`: `npm ci` and
`npm start` (Node.js 20 or newer). You then need git and Node.js before you begin.

## 2. The setup assistant

On first launch the **Setup** screen opens by itself. You can reopen it at any time with the
**⬇** button at the top right.

It lists five steps. Each line shows a chip:

- **green**: it is there, nothing to do;
- **red**: it is missing, and a yellow button offers to get it;
- **blue**, with a percentage: in progress.

The screen refreshes by itself. You can close and reopen it: it starts from the real state of
your machine, not from what it remembers doing.

### Step 1: the workspace folder

This is **the** folder of the project: the sources and Godot will sit in it, side by side.

- Click **Choose…** and pick an empty folder, on a disk with room.
- Avoid a very long path or one with special characters.
- Already cloned repositories somewhere? Choose the folder that holds them: they are recognised,
  and never modified.

### Step 2: the programs

| Program | What it is for |
|---|---|
| **git** | fetches the project's sources |
| **Docker** | runs "containers", small isolated machines; every service of the game is one |
| **minikube** | a small Kubernetes cluster on your machine, inside Docker: it hosts the services |
| **kubectl** | the command that talks to the cluster (the panel uses it all the time) |
| **Helm** | installs things in the cluster. Version **3** or **4** |
| **.NET 9 SDK** | builds the C# part of the game |

- **minikube, kubectl, Helm**: click **Download**. The panel takes them from their publisher,
  checks each file, and keeps them in its own folder. No administrator rights, nothing else on
  your machine is changed.
- **git, Docker, .NET** on Windows: click **Install**. Windows asks for permission, accept. Follow
  the progress in the `setup` tab at the bottom of the window.
- **Docker** then needs you to **sign out and back in** (or restart). Do it, start Docker Desktop
  once, then start the panel again: the assistant picks up where it was.
- On Linux the panel never calls `sudo`: it shows the command for you to run.

### Step 3: the sources

Click **Clone** on each line.

| Repository | Content | Size |
|---|---|---|
| `kubernetes` | the description of every service, and the scripts that start the stack | small |
| `DyingStar` | the game: client and game server | **about 2.4 GB**, several minutes |
| `horizonserver`, `services` | only if you want to change those services | small |

Which repositories are asked for depends on your profile: no need to clone what you will not use.

### Step 4: Godot

The project uses **its own** Godot (C#, double precision). The one from godotengine.org does not
work with it. Click **Download**: about 110 MB, placed in the workspace folder.

The "C# packages" of the next line come with it.

### Step 5: the local stack

Everything the game needs behind it: about thirty services (accounts, missions, economy, voice…)
running in the cluster.

- Click **Start the stack**. The first time, Windows asks for administrator rights.
- **The first start takes 10 to 25 minutes**: the images of the services are downloaded.
- Follow the progress at the top of the window, **pods** light: `12/27 ready`, then `27/27 ready`.

When the five steps are green the assistant says "Everything is in place". Close it.

## 3. Choose your profile

Open the **Settings** (the ⚙ gear at the top right), section **Profile**.

| Profile | For whom | What you see |
|---|---|---|
| **Developer** | most people | core, game server, game services, admin; the editor, the clients |
| **Services developer** | you change the game services | the same, without the local game server tools |
| **Game server developer** | you change the game server's code | a placeholder pod for the server, which runs from your sources behind Telepresence |
| **Level designer** | you work in the editor | the minimum cluster (core only) plus your local game server; the editor and the clients |
| **Full stack** | everything, comfortable machine | all the sets, voice and monitoring included |

A profile changes what the panel **shows and starts**, and which **sets of services** the local
cluster deploys (the minimum is the *core*). You can change it whenever you like, tick or untick a
single module just below it, and add or remove a set on a running cluster from the **Services**
card.

## 4. Reading the window

**At the top, the lights.** One per thing watched: green, it works; amber, not yet; red, a
problem. Hover one for the detail.

**On the left, the cards.** Each has a **?** next to its title: hover it to learn what its
buttons do.

- **Start everything**: starts what is needed, in the right order. The **Start sequence** just
  below shows where it is, step by step.
- **Editor and clients**: opens the project in Godot, or launches game clients. Each client is
  logged in by itself as a test player.
- **Platform** and **Pods**: the state of the cluster. A pod's cross restarts it.
- **Red zone**: the actions with no way back. Leave it alone unless you know.

**On the right, the logs.** One tab per service or program. The search bar filters while the
lines scroll; the `ERROR` and `WARN` buttons keep only the problems.

## 5. Entering the world

1. Click **Start everything** and wait for the sequence to be entirely green.
2. Click **Launch the clients**. The button stays greyed out while something is missing: its
   tooltip says what.
3. In the game, enter the universe.

## When it gets stuck

| What you see | What to do |
|---|---|
| **Docker** light red | Start Docker Desktop, wait a minute or two |
| **pods** stuck below the total | Look at the tab of the late pod, search for `ERROR`. Its cross restarts it |
| **Launch the clients** greyed out | Hover the button: it says what is missing |
| The client shows "ERROR 1337" | Horizon cannot be reached: look at the **horizon** light |
| A download fails | The file is deleted and the message says why. Try again: nothing is kept half-done |
| You are lost | Copy the lines of the `panel` tab (**Copy** button) and send them to the team |

## Stopping and coming back

- **Stop everything** stops what the panel started (game server, clients). The cluster stays,
  and so does its data.
- Closing the panel deletes nothing.
- The next day: start the panel, **Start everything**. Two minutes, not twenty-five.
