# DyingStar Kubernetes Infrastructure

This repository contains the Kubernetes infrastructure and microservices configuration for the **DyingStar** gaming platform, deployed using Helm charts.

## Environments

| Environment | Namespace | Deploy Method | Description |
|-------------|-----------|---------------|-------------|
| **Production** | `dyingstar-prod` | `repository_dispatch` (from service repos) | Live production environment. |
| **Preprod** | `dyingstar-preprod` | `repository_dispatch` (from service repos) | Staging environment for validated code before release. |
| **Dev Local** | `dyingstar` | Manual `helm install` | Local environment via Skaffold/Minikube, primarily for developers. |

## Charts Overview

| Chart | Purpose | Source Repository |
|-------|---------|-------------------|
| `godotserver` | Godot multiplayer game server (headless service) | `../DyingStar` |
| `horizon` | Horizon game server (NodePort, high CPU) | `../horizonserver` |
| `service-resourcesdynamic` | Dynamic resource manager API + WebSocket (with PostgreSQL) | `../services/resourcesDynamic` |
| `keycloak` | Keycloak identity provider (Player Auth + Discord IdP) | `../services/keycloak` |
| `livekit` | LiveKit Server (WebRTC SFU + TURN) for voice/video rooms | `../services/livekit` |
| `service-persistence` | Persistence service — ScyllaDB-backed data layer (Rust) | `../services/persistence` |
| `dev-services` | Shared developer infrastructure (PostGIS, etc.) | *Included in this repo* |

## Repository Structure

```text
├── .github/
│   ├── copilot-instructions.md
│   └── workflows/
│       ├── deploy-prod.yaml       # CD: repository_dispatch → dyingstar-prod
│       └── deploy-preprod.yaml    # CD: repository_dispatch → dyingstar-preprod
├── argocd/                        # Official chart values for ArgoCD
├── traefik/                       # Official chart values for Traefik
├── cert-manager/                  # Official chart values for Cert-Manager
├── godotserver/                   # Helm chart
├── horizon/                       # Helm chart
├── service-resourcesdynamic/      # Helm chart
├── keycloak/                      # Helm chart
├── livekit/                       # Helm chart
├── service-persistence/           # Helm chart
├── dev-services/                  # Helm chart (shared dev infra)
├── dev-projects.yaml              # Local build targets (read by build-and-deploy)
├── scripts_linux/                 # Linux/macOS scripts (bash)
│   ├── check-dev.sh               # Dependency check script
│   ├── start-dev.sh               # Environment startup script
│   ├── clean-dev.sh               # Environment cleanup script
│   ├── build-and-deploy.sh        # Local image build + deploy
│   ├── expose-horizon.sh          # Self-healing port-forward relay
│   └── dev.sh                     # Legacy Skaffold wrapper
└── scripts_windows/               # Windows scripts (PowerShell)
    ├── check-dev.ps1              # Dependency check script
    ├── start-dev.ps1              # Environment startup script
    ├── clean-dev.ps1              # Environment cleanup script
    ├── build-and-deploy.ps1       # Local image build + deploy
    └── expose-horizon.ps1         # Self-healing port-forward relay

```

**Note on Chart configurations:**
Each chart contains multiple value files for different environments:

* `values.yaml` — Base (environment-neutral) defaults
* `values-prod.yaml` — Production overrides
* `values-preprod.yaml` — Pre-production overrides
* `values-dev.yaml` — Local development overrides (Minikube)

---

## Local Development (Minikube & Telepresence)

### Introduction

Our local development workflow uses cross-platform tools compatible with both Linux and Windows. This ensures that the local environment closely mirrors pre-production and production, providing a consistent workflow across different operating systems.

### Prerequisites

Please ensure the following tools are installed:

* [Minikube](https://minikube.sigs.k8s.io/docs/start/)
* [Telepresence](https://telepresence.io/docs/install/client)
* [Helm](https://helm.sh/docs/intro/install/)
* [Freelens](https://freelensapp.github.io/) (Optional: UI for managing pods and deployments)
* [k9s](https://k9scli.io/) (Optional: CLI UI for cluster management)

---

## Quick Start (Automated Install)

All scripts live in `scripts_linux/` (bash) and `scripts_windows/` (PowerShell).
Each one relocates itself to the repository root before doing anything, so the
commands below work from any working directory — the paths shown assume you are
at the root of the repository.

### Linux / macOS

```bash
# 1. Check dependencies
./scripts_linux/check-dev.sh 

# 2. Start the local environment
./scripts_linux/start-dev.sh

# 3. Clean up / stop the environment
./scripts_linux/clean-dev.sh

```

### Windows

```powershell
# 1. Check dependencies
.\scripts_windows\check-dev.ps1 

# 2. Start the local environment
.\scripts_windows\start-dev.ps1

# 3. Clean up / stop the environment
.\scripts_windows\clean-dev.ps1

```

### Telepresence Interception

Use Telepresence to intercept Minikube traffic and route it to your local machine for debugging.

```bash
# Connect to the local cluster
telepresence connect --namespace dyingstar

# List available interceptable services
telepresence list

# Intercept a specific service (e.g., godotserver on port 8980)
telepresence intercept godotserver --port 8980

# Stop intercepting
telepresence leave godotserver

# Disconnect from the cluster
telepresence quit

```

TODO

telepresence godot = run in local client + server



for Horizon, other method : 







---

## Manual Installation Guide

### 1. On Every Project Startup

Start Minikube with the necessary disk size and mount your local directory:

```bash
minikube start --disk-size=150g --mount-string $PWD:/mnt/local-repo.git

```

In a **separate terminal**, open the Minikube tunnel (keep this running):

```bash
minikube tunnel

```

### 2. Initial Setup (First Install Only)

Install Gateway API and ArgoCD:

```bash
# Apply Kubernetes Gateway API standard install
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml

# Add official ArgoCD Helm repository
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

# Install ArgoCD configured for local Minikube mounts
helm install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  -f argocd/values.yaml \
  -f argocd/values-dev.yaml 

# Apply ArgoCD root application
kubectl apply -f argocd/root-dev.yaml

```

### 3. DNS / Hosts File Configuration

Every time the stack is restarted, retrieve the external IP of the Traefik service and update your local `hosts` file (`/etc/hosts` on Linux/Mac, `C:\Windows\System32\drivers\etc\hosts` on Windows).

Example configuration:

```text
10.104.207.169  horizon.dyingstar.local
10.104.207.169  argocd.dyingstar.local

```

### 4. Reaching horizon from the host (and from the LAN)

`horizon` listens on 7040 but `horizon/values-dev.yaml` sets `service.type: ClusterIP`,
so **nothing is published on the host** — `192.168.49.2:7040` and `localhost:7040` both
fail by design. Two things follow from that.

**Port 7040 speaks WebSocket, not HTTP.** A plain `curl` or a browser GET will always
fail and will log `WebSocket handshake failed: No "Connection: upgrade" header` in the
horizon pod. That is the test being wrong, not the server. Check it with a real
handshake instead:

```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" \
     http://127.0.0.1:7040/          # expect: HTTP/1.1 101 Switching Protocols
```

**Use the relay script.** `kubectl port-forward` pins itself to one pod, so every
`build-and-deploy` breaks it — and the process often stays alive while broken, failing
only when a client connects. `scripts_linux/expose-horizon.sh` / `scripts_windows/expose-horizon.ps1` follow the pod
behind the Service and restart the forward as soon as it is replaced:

```bash
./scripts_linux/expose-horizon.sh              # 0.0.0.0:7040, survives rebuilds
./scripts_linux/expose-horizon.sh --local      # 127.0.0.1 only
./scripts_linux/expose-horizon.sh livekit 7880 # another service
```

```powershell
.\scripts_windows\expose-horizon.ps1
.\scripts_windows\expose-horizon.ps1 -Local
.\scripts_windows\expose-horizon.ps1 -Service livekit -Port 7880
```

Set the client's `websocket_url` to `ws://127.0.0.1:7040` on this host, or
`ws://<host-LAN-ip>:7040` from another machine.

**A remote machine can only come through this host.** Neither the `minikube tunnel`
LoadBalancer IP nor the node IP (`192.168.49.2`, on Docker's bridge) is routable from
the rest of the network — the host is the only machine with a route into the cluster,
which is why the relay binds `0.0.0.0` by default. On Linux the Fedora Workstation
firewall zone already allows `1025-65535/tcp`; on Windows an inbound rule is needed
(the command is in the script's header).

**The Traefik route is a separate path.** `horizon.dyingstar.local` goes through the
Gateway on **port 80**, not 7040, and needs `minikube tunnel` running plus the
`/etc/hosts` entries that `scripts_linux/start-dev.sh` writes (steps 4-7). If `kubectl get svc -n
traefik` shows `EXTERNAL-IP: <pending>`, the tunnel is not running and that whole path
is down.

### 5. Using Local Docker Images

Use `./scripts_linux/build-and-deploy.sh` (replaces Skaffold). It builds inside Minikube's Docker
daemon and patches the running Deployment to use that image with
`imagePullPolicy: Never` — no registry push, no git commit.

```bash
./scripts_linux/build-and-deploy.sh                 # interactive menu listing every target
./scripts_linux/build-and-deploy.sh horizon-data    # a single target
./scripts_linux/build-and-deploy.sh all             # everything
```

```powershell
.\scripts_windows\build-and-deploy.ps1                # same, on Windows
.\scripts_windows\build-and-deploy.ps1 horizon-data
.\scripts_windows\build-and-deploy.ps1 all
```

Both scripts implement the same behaviour and read the same `dev-projects.yaml`.
The PowerShell port differs only where it has to: it parses the YAML itself (no
`python3`/PyYAML or `powershell-yaml` dependency on a stock Windows box), and passes
the patch through `kubectl patch --patch-file` with a temp file rather than `-p`,
because native-command argument quoting mangles inline JSON on Windows.

Targets are declared in [`dev-projects.yaml`](dev-projects.yaml):

| Target | Source | Patches |
|--------|--------|---------|
| `godotserver` | `../DyingStar` | deployment `godotserver` |
| `horizon` | `../horizonserver` (`Dockerfile.server`) | deployment `horizon` |
| `horizon-plugins` | `../horizonserver` (`Dockerfile.plugins`) | init container `copy-plugins` |
| `horizon-data` | `../horizonserver` (`Dockerfile.data`) | init container `copy-props` |
| `resourcesdynamic` | `../services/resourcesDynamic` | deployment `service-resourcesdynamic` |
| `persistence` | `../services/persistence` | deployment `service-persistence` |
| `monitoring` | `../services/monitoring` | deployment `service-monitoring` |

**Init images.** Horizon's plugins and generic props are not baked into the server
image: they ship as separate images whose only job is to copy their payload into a
shared `emptyDir` at pod startup (`horizon/templates/deployment.yaml`). A target with
an `initContainer` field patches that init container instead of the main one — which
is why editing a `ds_genericprops` JSON file is a ~2s rebuild (`horizon-data`) rather
than a full Rust build.

Init containers are patched **by name**, not by index: `copy-props` currently sits at
index 6 and that position shifts with every `dependsOn` entry added to
`horizon/values.yaml`.

**Stable tags and forced restarts.** The image tag (`:dev`) never changes, so when only
the image *contents* change the pod template is byte-identical, `kubectl patch` reports
`(no change)` and Kubernetes triggers no rollout — the pod would keep serving the old
`emptyDir` payload. The script detects this by comparing `.metadata.generation` around
the patch and issues a `kubectl rollout restart` only in that case (restarting
unconditionally would cause two rollouts whenever the image reference genuinely
changed). The `kubectl.kubernetes.io/restartedAt` annotation this adds is absent from
ArgoCD's desired manifest, so it does not register as drift and needs no
`ignoreDifferences` entry.

**Why it survives ArgoCD.** Dev apps run with `selfHeal: true`, so a manual patch is
normally reverted within a few minutes. Each affected Application in
`argocd/dev/game/` therefore declares an `ignoreDifferences` block covering the image
and `imagePullPolicy`, plus `RespectIgnoreDifferences=true` in `syncOptions` so a sync
triggered by an unrelated commit does not re-apply the Harbor image either.

> ⚠️ ArgoCD reads `file:///mnt/local-repo.git` at its **committed** state. Changes to
> `argocd/dev/game/*.yaml` (or to any chart) must be committed to take effect.
> Changes to `dev-projects.yaml` and `scripts_linux/build-and-deploy.sh` are local to the script and
> need no commit.

The script refuses to run unless the current kube-context is `minikube` — it forces
`imagePullPolicy: Never`, which would break any cluster without the local image.

#### Manual equivalent

```bash
# Point your terminal to Minikube's docker daemon
eval $(minikube -p minikube docker-env)

# Build your image directly inside Minikube
docker build -t service-resourcesdynamic:dev .

# Strategic merge patch — `name` is the merge key, so no index to compute
kubectl patch deployment service-resourcesdynamic -n dyingstar -p '{
  "spec": {"template": {"spec": {"containers": [{
    "name": "service-resourcesdynamic",
    "image": "service-resourcesdynamic:dev",
    "imagePullPolicy": "Never"
  }]}}}
}'
```
