# StarDeception Kubernetes

Helm charts for the **StarDeception** gaming platform microservices.

## Environments

| Environment | Namespace | Deploy Method |
|-------------|-----------|---------------|
| **Production** | `dyingstar-prod` | `repository_dispatch` from service repos |
| **Preprod** | `dyingstar-preprod` | `repository_dispatch` from service repos |
| **Dev Shared** | `dyingstar-dev-shared` | Manual `helm install` |
| **Dev Local** | `dyingstar-dev-local` | Skaffold on minikube |

## Charts

| Chart | Purpose | Source Repo |
|-------|---------|-------------|
| `godotserver` | Godot multiplayer game server (headless service) | `../StarDeception` |
| `horizon` | Horizon game server (NodePort, high CPU) | `../network` |
| `service-resourcesdynamic` | Dynamic resource manager API + WebSocket, with PostgreSQL | `../services/resourcesDynamic` |
| `keycloak` | Keycloak identity provider (player auth + Discord IdP) | `../services/keycloak` |
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

### Manual Deployment

> **Kube contexts**: this workspace has two kube-contexts — `dyingstar` (cluster
> serving prod **and** preprod) and `minikube` (dev-local). Always select the
> right one before running `helm`/`kubectl`. The examples below pin it via
> `--kube-context=dyingstar`.

```bash
# Production
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod godotserver ./godotserver -f godotserver/values-prod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod horizon ./horizon -f horizon/values-prod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod service-resourcesdynamic ./service-resourcesdynamic -f service-resourcesdynamic/values-prod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-prod keycloak ./keycloak -f keycloak/values-prod.yaml --set image.tag=<tag>

# Preprod
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod godotserver ./godotserver -f godotserver/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod horizon ./horizon -f horizon/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod service-resourcesdynamic ./service-resourcesdynamic -f service-resourcesdynamic/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install --kube-context=dyingstar -n dyingstar-preprod keycloak ./keycloak -f keycloak/values-preprod.yaml --set image.tag=<tag>
```

### Manual trigger via workflow_dispatch

You can also trigger deployments manually from the GitHub Actions UI, providing the chart name and image tag.

---

## Local Development (Skaffold + minikube)

### Prerequisites

- [minikube](https://minikube.sigs.k8s.io/docs/start/)
- [Skaffold](https://skaffold.dev/docs/install/)
- [Helm](https://helm.sh/docs/intro/install/)
- Sibling service repos cloned:
  - `../StarDeception` — godotserver
  - `../network` — horizon
  - `../services/resourcesDynamic` — service-resourcesdynamic
  - `../services/keycloak` — keycloak

### Quick Start

```bash
# Start minikube, the size is important because the docker images are built inside the minikube
minikube start --disk-size=60g --extra-config=apiserver.service-node-port-range=1024-65535

# Deploy all services
./dev.sh

# Or deploy a single service
./dev.sh horizon
```

Skaffold builds Docker images using Dockerfiles from the sibling repos and deploys via Helm with `values-dev-local.yaml` into namespace `dyingstar-dev-local`.

### Skip Building Unchanged Services

To avoid rebuilding services you haven't modified, you can pull pre-built `develop` images from Harbor instead of building locally.

**Setup (one-time):**

```bash
cp dev-local.conf.example dev-local.conf
```

**Edit `dev-local.conf`** — uncomment services you want to pull from Harbor:

```conf
# Services to pull from Harbor instead of building locally.
#godotserver
horizon
#service-resourcesdynamic
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
skaffold dev -m godotserver,horizon,service-resourcesdynamic          # all local builds
skaffold dev -m horizon                                               # single service
skaffold dev -m godotserver,horizon-harbor,service-resourcesdynamic   # mix local + harbor
```

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
