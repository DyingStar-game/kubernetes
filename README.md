# StarDeception Kubernetes

Helm charts for the **DyingStar** gaming platform microservices.

## Environments

| Environment | Namespace | Deploy Method | comment |
|-------------|-----------|---------------|---------|
| **Production** | `dyingstar-prod` | `repository_dispatch` from service repos | for the production |
| **Preprod** | `dyingstar-preprod` | `repository_dispatch` from service repos | for preproduction, so code validated but not yet released |
| **Dev Shared** | `dyingstar-dev-shared` | Manual `helm install` | for services used by all developpers, like Postgis |
| **Dev Local** | `dyingstar` | ArgoCD on minikube | for run the game localy, mainly for developpers | 

## Charts

| Chart | Purpose | Source Repo |
|-------|---------|-------------|
| `godotserver` | Godot multiplayer game server (headless service) | `../DyingStar` |
| `horizon` | Horizon game server (NodePort, high CPU) | `../horizonserver` |
| `service-resourcesdynamic` | Dynamic resource manager API + WebSocket, with PostgreSQL | `../services/resourcesDynamic` |
| `keycloak` | Keycloak identity provider (player auth + Discord IdP; a second, upstream-image instance runs in dev-shared for GitHub login) | `../services/keycloak` |
| `livekit` | LiveKit Server (WebRTC SFU + TURN) for voice/video rooms | `../services/livekit` |
| `service-persistence` | Persistence service — ScyllaDB-backed data layer (Rust) | `../services/persistence` |
| `dev-services` | Shared developer infrastructure (PostGIS) | — |
| `nextcloud` | Nextcloud 3D asset library (TrueNAS/NFS storage, GitHub login via Keycloak) — dev-shared only | — |

## Repository Structure

```
├── .github/
│   ├── copilot-instructions.md
│   └── workflows/
│       ├── deploy-prod.yaml       # CD: repository_dispatch → dyingstar-prod
│       └── deploy-preprod.yaml    # CD: repository_dispatch → dyingstar-preprod
├── godotserver/                   # Helm chart
├── horizon/                       # Helm chart
├── service-resourcesdynamic/      # Helm chart
├── keycloak/                      # Helm chart
├── livekit/                       # Helm chart
├── service-persistence/           # Helm chart
├── dev-services/                  # Helm chart (shared dev infra)
├── nextcloud/                     # Helm chart (shared dev infra, 3D asset library)
├── argocd/                        # ArgoCD Applications (dev + preprod)
├── dev-projects.yaml              # Local build targets (read by build-and-deploy)
├── scripts_linux/                 # Linux/macOS scripts (bash)
└── scripts_windows/               # Windows scripts (PowerShell)
```

Each chart contains:
- `values.yaml` — base (env-neutral) defaults
- `values-prod.yaml` — production overrides
- `values-preprod.yaml` — preprod overrides
- `values-dev.yaml` — local dev overrides (minikube, deployed by ArgoCD)

---

## Production / Preprod Deployment

### Automated (CI/CD)

Service repos build and push Docker images to Harbor, then trigger this repo's workflows via `repository_dispatch`:

```bash
# From a service repo's GitHub Actions, after pushing an image:
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/kubernetes/dispatches \
  -d '{"event_type":"deploy-prod","client_payload":{"chart":"horizon","image_tag":"abc1234"}}'
```

For preprod, use `"event_type": "deploy-preprod"`.

This query will trigger the deployment on the environment selected.


### Manual Deployment

> **Kube contexts**: this workspace has two kube-contexts — `dyingstar` (cluster
> serving prod **and** preprod) and `minikube` (dev-local). Always select the
> right one before running `helm`/`kubectl`. The examples below pin it via
> `--kube-context=dyingstar`.

It's main used for personn have the management of preprod / prod and have the minikube for develop.


```bash
# Production
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod godotserver ./godotserver -f godotserver/values-prod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod horizon ./horizon -f horizon/values-prod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod service-resourcesdynamic ./service-resourcesdynamic -f service-resourcesdynamic/values-prod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod keycloak ./keycloak -f keycloak/values-prod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod livekit ./livekit -f livekit/values-prod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod service-persistence ./service-persistence -f service-persistence/values-prod.yaml --set image.tag=<tag>

# Preprod
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod godotserver ./godotserver -f godotserver/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod horizon ./horizon -f horizon/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod service-resourcesdynamic ./service-resourcesdynamic -f service-resourcesdynamic/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod keycloak ./keycloak -f keycloak/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod livekit ./livekit -f livekit/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod service-persistence ./service-persistence -f service-persistence/values-preprod.yaml --set image.tag=<tag>
```


### Manual trigger via workflow_dispatch

You can also trigger deployments manually from the GitHub Actions UI, providing the chart name and image tag.



## Local Development (minikube + ArgoCD)

### Introduction

We use tools, working all on Linux and Windows.

It permit to have something very close to the preprod and prod and working on same way on different Operating Systems.

The local stack runs on minikube: ArgoCD reconciles the Applications declared in
`argocd/dev/` into the namespace `dyingstar`, each chart being rendered with its
`values-dev.yaml`. By default every service uses the `develop` image from Harbor —
you only build locally the service you are working on.

See [Refacto.md](Refacto.md) for the detailed / manual installation guide.

### Prerequisites

- [minikube](https://minikube.sigs.k8s.io/docs/start/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [Helm](https://helm.sh/docs/intro/install/)
- Docker (under Windows, docker on WSL)
- [Telepresence](https://telepresence.io/docs/install/client)
- Sibling service repos cloned (only those you build locally):
  - `../DyingStar` — godotserver
  - `../horizonserver` — horizon
  - `../services/resourcesDynamic` — service-resourcesdynamic
  - `../services/keycloak` — keycloak
  - `../services/livekit` — livekit
  - `../services/persistence` — service-persistence
- [freelens](https://freelensapp.github.io/), used to manage pods and deployments in an UI

### Quick Start

Every script relocates itself to the repository root, so it can be run from anywhere.

```bash
# 1. Check the dependencies
./scripts_linux/check-dev.sh

# 2. Start minikube + the whole stack (ArgoCD, Traefik, game services)
./scripts_linux/start-dev.sh

# 3. Stop / clean up the environment
./scripts_linux/clean-dev.sh
```

```powershell
# Windows equivalents
.\scripts_windows\check-dev.ps1
.\scripts_windows\start-dev.ps1
.\scripts_windows\clean-dev.ps1
```

**BE CAREFUL: the creation of the services can take 10 to 25 minutes**, depending on your
computer. Follow them in freelens, in the namespace `dyingstar`: all pods must be
`Running`.

### Client URL

In the dyingstar repository (godot files), edit `client.ini`:

```ini
[network]
websocket_url="ws://horizon.dyingstar.local:80"
```

This route goes through Traefik and needs `minikube tunnel` running plus the
`/etc/hosts` entries written by `start-dev.sh`. As an alternative (and the only way to
reach the cluster from another machine of the LAN), use the port-forward relay:

```bash
./scripts_linux/expose-horizon.sh          # binds 0.0.0.0:7040 → horizon
```

```powershell
.\scripts_windows\expose-horizon.ps1
```

then set `websocket_url="ws://127.0.0.1:7040"` (or `ws://<host-LAN-ip>:7040`).

### Build a Service Locally

`build-and-deploy` builds the image inside minikube's Docker daemon and patches the
running Deployment to use it (`imagePullPolicy: Never`) — no registry push, no commit.

```bash
./scripts_linux/build-and-deploy.sh                 # interactive menu listing every target
./scripts_linux/build-and-deploy.sh horizon         # a single target
./scripts_linux/build-and-deploy.sh all             # everything
```

```powershell
.\scripts_windows\build-and-deploy.ps1 horizon-data
```

The targets (`godotserver`, `horizon`, `horizon-plugins`, `horizon-data`,
`resourcesdynamic`, `persistence`, `monitoring`) are declared in
[`dev-projects.yaml`](dev-projects.yaml).

### Scenarii

Couple scenarii in example, depend on what part you develop in local.

#### No develop, only test

Nothing to build: `start-dev.sh` already deploys the `develop` images from Harbor.

#### Develop godot client & server

For this case, you develop only godot, so Horizon, services... are the `develop`
version because we don't modify them.

We must modify some files to allow horizon access the godot server you run locally
(inside godot editor with `F5`):

In file `horizon/values-dev.yaml`, uncomment 3 lines, to have:

```yaml
extraEnv:
 - name: GAME_SERVER_HOST
   value: "host.minikube.internal"
```

In file `horizon/values.yaml`, comments the 3 lines in `dependsOn`, to have:

```yaml
  # - name: godotserver
  #   service: godotserver
  #   port: 8980
```

*This mean Horizon not wait godotserver pods up because we not use them in this scenario.*

In godot, in menu *Debug* -> *Customize Run Instances...*, check *enable multiple
instances* and set to 2.

The second line will be the server, define:

- *Launch arguments*: `--headless`
- *Feature Flags*: `dedicated_server`

You can run with *F5* key.

In *Launch arguments*, you can append `--log-file /tmp/godot/player.log` and
`--log-file /tmp/godot/server.log` for have log files.

After start run with *F5* in godot, open *Freelens*, go in *Workloads* and *pods*, you
can delete the line starts with *horizon-*. This will restart Horizon and connect to
your Godot server. After 20 - 40 seconds, you can connect to game server from client.

#### Develop Horizon

Clone [horizonserver](https://github.com/DyingStar-game/horizonserver) next to this
repository, then build the part you modified:

```bash
./scripts_linux/build-and-deploy.sh horizon           # the server itself
./scripts_linux/build-and-deploy.sh horizon-plugins   # the plugins image
./scripts_linux/build-and-deploy.sh horizon-data      # the ds_genericprops JSON files
```

**NOTE**: you can mix this chapter and previous chapter if you made modifications in
godotserver and horizon in same time!

#### Develop service Resourcesdynamic

```bash
./scripts_linux/build-and-deploy.sh resourcesdynamic
```

---

## Shared Dev Services

Shared infrastructure for all developers, deployed on the main cluster.

**PostGIS** (chart `dev-services`), available via NodePort (default `30432`). The
deployed release overrides `postgis.auth.username` and `postgis.auth.password` on
the command line, so they are not in git:

```bash
helm upgrade --install --kube-context=dyingstar -n dyingstar-dev-shared \
  dev-services ./dev-services --create-namespace \
  --set postgis.auth.username=<user> --set postgis.auth.password=<password>
```

**Nextcloud** — the 3D asset library for the modelers: files on TrueNAS over NFS,
login with a GitHub account through a Keycloak instance dedicated to this
namespace. Apart from TrueNAS, every component runs in `dyingstar-dev-shared`.

It needs secrets, a TrueNAS dataset, DNS records and a configured Keycloak realm
before the first install — the whole procedure is in
[`nextcloud/README.md`](nextcloud/README.md). In short:

```bash
# 1. Keycloak for this namespace (upstream image, no player realm, no Discord)
helm upgrade --install --kube-context=dyingstar -n dyingstar-dev-shared \
  keycloak ./keycloak -f keycloak/values-dev-shared.yaml \
  --set postgresql.auth.password=<password>

# 2. Realm, client, groups and the GitHub identity provider
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... ./nextcloud/scripts/bootstrap-keycloak.sh

# 3. Nextcloud itself
helm dependency update ./nextcloud
helm upgrade --install --kube-context=dyingstar -n dyingstar-dev-shared \
  nextcloud ./nextcloud -f nextcloud/values-dev-shared.yaml
```

| Service | URL |
|---------|-----|
| Nextcloud | `https://cloud.dev.dyingstar-game.space` |
| Keycloak (dev-shared) | `https://auth.dev.dyingstar-game.space` |

---

## Service Details

### Godot Server
- **Port**: 8980 (headless service)
- **Prod replicas**: 30

### Horizon
- **Port**: 7040 (NodePort)
- **Prod NodePort**: 30000, Preprod NodePort: 30100
- **High CPU** — requires 20+ cores in production

### Service Resources Dynamic
- **Ports**: 3001 (HTTP API), 9200 (WebSocket)
- **Database**: Bundled PostgreSQL (configurable per environment)
- Environment variable `DATABASE_URL` is auto-configured from chart values

### Service Persistence
- **Port**: 9100 (WebSocket, Rust)
- **Database**: Bundled ScyllaDB 6.2 (CQL port 9042) with `PasswordAuthenticator`
- Environment variables `SCYLLA_NODES` (as `host:port`), `SCYLLA_KEYSPACE`, `SCYLLA_USERNAME`, `SCYLLA_PASSWORD` are auto-configured from chart values
- Dev-local: ScyllaDB runs with `--developer-mode 1 --smp 1` (no PVC — emptyDir); prod/preprod use a PVC (10Gi/2Gi)
- **Important**: change the default `cassandra` superuser password in prod/preprod after first deploy via CQL:
  ```sql
  ALTER USER cassandra WITH PASSWORD '<new-strong-password>';
  ```

### Keycloak
- **Ports**: 8080 (HTTP), 9000 (management/health/metrics)
- **Database**: Bundled PostgreSQL (single-pod, mirrors `service-resourcesdynamic`)
- **Hostnames**: `auth.dyingstar-game.com` (prod), `auth-preprod.dyingstar-game.com` (preprod), NodePort `30180` (dev-local)
- **Realm**: `dyingstar` — imported on every start from the JSON baked into the image
- **Discord IdP** is registered/updated by a Helm post-install Job (`kcadm.sh` script shipped in `../services/keycloak`)
- **Required Secrets** (operator-managed in prod/preprod, inlined in `values-dev.yaml` for local dev):
  - `keycloak-admin` — keys `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`
  - `keycloak-discord` — keys `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- **Discord OAuth callback URLs** to register on the Discord developer portal:
  - prod:    `https://auth.dyingstar-game.com/realms/dyingstar/broker/discord/endpoint`
  - preprod: `https://auth-preprod.dyingstar-game.com/realms/dyingstar/broker/discord/endpoint`
  - local:   `http://<minikube-ip>:30180/realms/dyingstar/broker/discord/endpoint`

Create the prod/preprod secrets with:

```bash
kubectl --context=dyingstar -n dyingstar-prod create secret generic keycloak-admin \
  --from-literal=KEYCLOAK_ADMIN=admin \
  --from-literal=KEYCLOAK_ADMIN_PASSWORD='<strong-password>'

kubectl --context=dyingstar -n dyingstar-prod create secret generic keycloak-discord \
  --from-literal=DISCORD_CLIENT_ID='<id>' \
  --from-literal=DISCORD_CLIENT_SECRET='<secret>'
```

### Nextcloud (dev-shared only)
- **Chart**: umbrella over the official `nextcloud/nextcloud` chart, plus this repo's own PostgreSQL, Redis, TrueNAS PV and nightly `pg_dump` CronJob
- **Hostname**: `cloud.dev.dyingstar-game.space`, exposed through the Traefik Gateway listener `nextcloud`
- **Storage**: static NFS PersistentVolume on TrueNAS — ZFS periodic snapshots are the backup
- **Auth**: `user_oidc` → the dev-shared Keycloak, realm `dyingstar-studio` → GitHub identity provider; write access = membership of the `ds-modelers` Keycloak group
- **Required Secrets** in `dyingstar-dev-shared`: `nextcloud-admin`, `nextcloud-postgresql`, `nextcloud-redis`, `nextcloud-oidc`
- Full setup guide: [`nextcloud/README.md`](nextcloud/README.md)

### Keycloak (dev-shared instance)
- **Values**: `keycloak/values-dev-shared.yaml` — same chart as prod/preprod, but the **upstream** `quay.io/keycloak/keycloak` image (no realm import, no Discord IdP Job) and `start` instead of `start --optimized`
- **Hostname**: `auth.dev.dyingstar-game.space`, Traefik Gateway listener `keycloakdev`
- **Realm**: `dyingstar-studio`, created by `nextcloud/scripts/bootstrap-keycloak.sh` (GitHub IdP, `nextcloud` client, groups `ds-modelers` / `ds-viewers`)
- **Required Secret**: `keycloak-admin` — keys `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`
- Its database password is passed with `--set postgresql.auth.password` on every upgrade (that chart has no `existingSecret` support for PostgreSQL)
- Entirely independent from the prod/preprod Keycloak instances — different namespace, database, admin account and realms

> **One-off migration for every existing `keycloak` release.** The chart used to
> select its server pods on `app.kubernetes.io/name` + `instance` only — labels
> the bundled PostgreSQL Deployment and the Discord bootstrap Job also carry, so
> the `keycloak` Service load-balanced part of its HTTP traffic onto PostgreSQL.
> The fix adds `app.kubernetes.io/component: server` to the selector.
>
> **Do not just run `helm upgrade`.** Helm applies a Service before a Deployment:
> the Service would start requiring `component: server`, which the running pods do
> not carry yet, dropping its endpoints to zero — and the Deployment patch that
> would fix them fails right after, because `spec.selector` is immutable. Without
> `--atomic` nothing rolls back, so Keycloak ends up unreachable.
>
> The `repository_dispatch` workflows only run `kubectl rollout restart`, never
> `helm upgrade`, so merging the chart change does not trigger this on its own.
>
> Delete the Deployment first (≈1-3 min of downtime while the new pod imports the
> realm):
>
> ```bash
> kubectl --context=dyingstar -n <namespace> delete deploy keycloak
> helm upgrade --install --kube-context=dyingstar -n <namespace> \
>   keycloak ./keycloak -f keycloak/values-<env>.yaml
> kubectl --context=dyingstar -n <namespace> rollout status deploy/keycloak --timeout=10m
> ```
>
> Or, with no downtime, label the running server pod first so the new Service
> selector keeps matching it, and let the old ReplicaSet serve during the switch.
> The `!app.kubernetes.io/component` clause is what keeps PostgreSQL out of it:
>
> ```bash
> kubectl --context=dyingstar -n <namespace> label pod \
>   -l 'app.kubernetes.io/name=keycloak,app.kubernetes.io/instance=keycloak,!app.kubernetes.io/component' \
>   app.kubernetes.io/component=server
> kubectl --context=dyingstar -n <namespace> delete deploy keycloak --cascade=orphan
> helm upgrade --install --kube-context=dyingstar -n <namespace> \
>   keycloak ./keycloak -f keycloak/values-<env>.yaml
> # then drop the orphaned ReplicaSet once the new pod is Ready
> kubectl --context=dyingstar -n <namespace> get rs -l app.kubernetes.io/name=keycloak
> ```
>
> The database is a separate Deployment with its own PVC and is not affected.

> **Rollout strategy on the bundled databases.** `keycloak`, `dev-services`
> (PostGIS), `service-resourcesdynamic` and `livekit` (Redis) declared their
> stateful Deployment with the default `RollingUpdate`. That starts the new pod
> before stopping the old one, and on a single-node cluster both mount the same
> ReadWriteOnce PVC — two engines writing one data directory, which corrupts it
> (`PANIC: could not locate a valid checkpoint record`). All four now declare
> `strategy: Recreate`, as `service-persistence` already did.
>
> `strategy` is a mutable field and is not part of the pod template, so applying
> the fix triggers no rollout. Run a plain `helm upgrade` on each release
> **before** the next change to its pod template.

---

## GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `KUBE_CONFIG` | Base64-encoded kubeconfig for the target cluster |

Service repos also need a `KUBERNETES_REPO_TOKEN` (GitHub PAT) to trigger `repository_dispatch`.

## Create token for trigger github actions for deploy develop / pre-prod

**This part is for repository admin, becasue the token is only for 1 year, need to renew and so configure again on same way!**

`KUBERNETES_REPO_TOKEN` is a **GitHub Personal Access Token (PAT)** that allows the service repo to trigger `repository_dispatch` on the kubernetes repo.

### How to create it

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set:
   - **Token name**: e.g. `deploy-preprod-dispatch`
   - **Expiration**: your preference
   - **Resource owner**: your org (the one owning the kubernetes repo)
   - **Repository access**: select **Only select repositories** → pick the **kubernetes** repo
   - **Permissions → Repository permissions**:
     - **Contents**: Read
     - **Metadata**: Read (auto-selected)
4. Generate and copy the token
5. Add it as an **organization-level secret** named `KUBERNETES_REPO_TOKEN` (Settings → Secrets and variables → Actions → Organization secrets)

The `peter-evans/repository-dispatch` action in build-preprod.yaml uses this token to POST the `deploy-preprod` event to the kubernetes repo's API.
