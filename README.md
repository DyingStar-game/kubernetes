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
├── dev-services/                  # Helm chart (shared dev infra)
└── skaffold.yaml                  # Local dev orchestration
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

```bash
# Production
helm upgrade --install -n dyingstar-prod godotserver ./godotserver -f godotserver/values-prod.yaml --set image.tag=<tag>
helm upgrade --install -n dyingstar-prod horizon ./horizon -f horizon/values-prod.yaml --set image.tag=<tag>
helm upgrade --install -n dyingstar-prod service-resourcesdynamic ./service-resourcesdynamic -f service-resourcesdynamic/values-prod.yaml --set image.tag=<tag>

# Preprod
helm upgrade --install -n dyingstar-preprod godotserver ./godotserver -f godotserver/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install -n dyingstar-preprod horizon ./horizon -f horizon/values-preprod.yaml --set image.tag=<tag>
helm upgrade --install -n dyingstar-preprod service-resourcesdynamic ./service-resourcesdynamic -f service-resourcesdynamic/values-preprod.yaml --set image.tag=<tag>
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

### Quick Start

```bash
# Start minikube, the size is important because the docker images are built inside the minikube
minikube start --disk-size=60g

# Deploy all services
skaffold dev

# Or deploy a single service
skaffold dev -p horizon
```

Skaffold builds Docker images using Dockerfiles from the sibling repos and deploys via Helm with `values-dev-local.yaml` into namespace `dyingstar-dev-local`.

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
