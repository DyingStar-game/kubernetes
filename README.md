# StarDeception Kubernetes

Helm charts for the **DyingStar** gaming platform microservices.

## Environments

| Environment | Namespace | Deploy Method | comment |
|-------------|-----------|---------------|---------|
| **Production** | `dyingstar-prod` | `repository_dispatch` from service repos | for the production |
| **Preprod** | `dyingstar-preprod` | `repository_dispatch` from service repos | for preproduction, so code validated but not yet released |
| **Dev Shared** | `dyingstar-dev-shared` | Manual `helm install` | for services used by all developpers, like Postgis |
| **Dev Local** | `dyingstar-dev-local` | Skaffold on minikube | for run the game localy, mainly for developpers | 

## Charts

| Chart | Purpose | Source Repo |
|-------|---------|-------------|
| `godotserver` | Godot multiplayer game server (headless service) | `../DyingStar` |
| `horizon` | Horizon game server (NodePort, high CPU) | `../horizonserver` |
| `service-resourcesdynamic` | Dynamic resource manager API + WebSocket, with PostgreSQL | `../services/resourcesDynamic` |
| `keycloak` | Keycloak identity provider (player auth + Discord IdP) | `../services/keycloak` |
| `livekit` | LiveKit Server (WebRTC SFU + TURN) for voice/video rooms | `../services/livekit` |
| `dev-services` | Shared developer infrastructure (PostGIS) | — |

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
├── dev-services/                  # Helm chart (shared dev infra)
├── skaffold.yaml                  # Local dev orchestration
├── dev.sh                         # Local dev wrapper script
└── dev-local.conf.example         # Config template: Harbor vs local build
```

Each chart contains:
- `values.yaml` — base (env-neutral) defaults
- `values-prod.yaml` — production overrides
- `values-preprod.yaml` — preprod overrides
- `values-dev-local.yaml` — local dev overrides (minikube)

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

# Preprod
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod godotserver ./godotserver -f godotserver/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod horizon ./horizon -f horizon/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod service-resourcesdynamic ./service-resourcesdynamic -f service-resourcesdynamic/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod keycloak ./keycloak -f keycloak/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod livekit ./livekit -f livekit/values-preprod.yaml --set image.tag=<tag>
```


### Manual trigger via workflow_dispatch

You can also trigger deployments manually from the GitHub Actions UI, providing the chart name and image tag.



## Local Development (Skaffold + minikube)

### Introduction

We use tools, working all on Linux and Windows.

It permit to have something very close to the preprod and prod and working on same way on different Operating Systems.


### Prerequisites

- [minikube](https://minikube.sigs.k8s.io/docs/start/)
- [Skaffold](https://skaffold.dev/docs/install/)
- [Helm](https://helm.sh/docs/intro/install/)
- Sibling service repos cloned:
  - `../DyingStar` — godotserver
  - `../horizonserver` — horizon
  - `../services/resourcesDynamic` — service-resourcesdynamic
  - `../services/keycloak` — keycloak
  - `../services/livekit` — livekit
- [freelens](https://freelensapp.github.io/), used to manage pods and deployments in an UI

### Quick Start

```bash
# Start minikube, the size is important because the docker images can be built inside the minikube
minikube start --disk-size=150g --extra-config=apiserver.service-node-port-range=1024-65535

# Deploy all services
./dev.sh

# Or deploy a single service
./dev.sh horizon
```

Skaffold builds Docker images using Dockerfiles from the sibling repos and deploys via Helm with `values-dev-local.yaml` into namespace `dyingstar-dev-local`.

### Skip Building Unchanged Services

To avoid rebuilding services you haven't modified, you can pull pre-built `develop` images from Harbor instead of building locally.

**Setup (one-time):**

Copy the example config file to config file ^_^

```bash
cp dev-local.conf.example dev-local.conf
```

**Edit `dev-local.conf`** — uncomment services you want to pull from Harbor:

```conf
# Services to pull from Harbor instead of building locally.
#godotserver
horizon
#service-resourcesdynamic
#keycloak
```

In this example, `horizon` will be deployed using the Harbor `develop` image, while the other two are built from source.

Then run:

```bash
./dev.sh                          # Deploy all services
./dev.sh horizon                  # Deploy only horizon
./dev.sh godotserver horizon      # Deploy specific services
./dev.sh --tail=false             # Pass extra args to skaffold
```

> **Note**: minikube must be able to pull from Harbor. If Harbor requires authentication, create an `imagePullSecret` in the `dyingstar-dev-local` namespace.

You can also use Skaffold modules directly without the wrapper:

```bash
skaffold dev -m godotserver,horizon,service-resourcesdynamic,keycloak,livekit  # all local builds
skaffold dev -m horizon                                                       # single service
skaffold dev -m godotserver,horizon-harbor,service-resourcesdynamic,keycloak,livekit  # mix local + harbor
```

### Scenarii

Couple scenarii in example, depend on what part you develop in local.

In all scenarii, the godot client need to connect to Horizon running in the minikube.
In dyingstar repository (godot files), edit the file `client.ini` and replace the IP with the value return with the command: `minikube ip`.

In my case, it's *192.168.49.2*, so I define it:

```ini
[network]
websocket_url="ws://192.168.49.2:7040"
```


#### No develop, only test

For this case, we use all `develop` images. We build anothing in local.

In file `dev-local.conf`, uncomment all lines (remove the `#`).

On Linux:

```bash
./dev.sh
```

On Windows, set all tools (suffix with `-harbor`):

```
skaffold dev -m godotserver-harbor,horizon-harbor,service-resourcesdynamic-harbor,keycloak-harbor
```

#### Develop godot client & server

For this case, you develop only godot, so Horizon, services... are the `develop` version because we don't modify them.

We must modify some files to allow horizon access the godot server you run locally (inside godot editor with `F5`):

In file `horizon/values-dev-local.yaml`, uncomment 3 lines, to have:

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

In file `dev-local.conf`, uncomment only the line `godotserver` (remove the `#`).

On Linux:

```bash
./dev.sh
```

On Windows, set all tools (suffix with `-harbor`):

```
skaffold dev -m godotserver,horizon-harbor,service-resourcesdynamic-harbor,keycloak-harbor
```

In godot, in menu *Debug* -> *Customize Run Instances...*, check *enable multiple instances* and set to 2.

The second line will be the server, define:

- *Launch arguments*: `--headless`
- *Feature Flags*: `dedicated_server`

You can run with *F5* key.

In *Launch arguments*, you can append `--log-file /tmp/godot/player.log` and `--log-file /tmp/godot/server.log` for have log files.

After start run with *F5* in godot, open *Freelens*, go in *Workloads* and *pods*, you can delete the line starts with *horizon-*. This will restart Horizon and connect to your Godot server. After 20 - 40 seconds, you can connect to game server from client.

#### Develop Horizon



In file `dev-local.conf`, uncomment only the line `horizon` (remove the `#`).

On Linux:

```bash
./dev.sh
```

On Windows, set all tools (suffix with `-harbor`):

```
skaffold dev -m godotserver-harbor,horizon,service-resourcesdynamic-harbor,keycloak-harbor
```

**NOTE**: you can mix this chapter and previous chapter if you made modifications in godotserver and horizon in same time!

#### Develop service Resourcesdynamic

TODO: need mofdifications for this case


---

## Shared Dev Services

Shared infrastructure for all developers, deployed on the main cluster:

```bash
helm upgrade --install -n dyingstar-dev-shared dev-services ./dev-services --create-namespace
```

PostGIS available via NodePort (default `30432`).

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

### Keycloak
- **Ports**: 8080 (HTTP), 9000 (management/health/metrics)
- **Database**: Bundled PostgreSQL (single-pod, mirrors `service-resourcesdynamic`)
- **Hostnames**: `auth.dyingstar-game.com` (prod), `auth-preprod.dyingstar-game.com` (preprod), NodePort `30180` (dev-local)
- **Realm**: `dyingstar` — imported on every start from the JSON baked into the image
- **Discord IdP** is registered/updated by a Helm post-install Job (`kcadm.sh` script shipped in `../services/keycloak`)
- **Required Secrets** (operator-managed in prod/preprod, inlined in `values-dev-local.yaml` for local dev):
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
