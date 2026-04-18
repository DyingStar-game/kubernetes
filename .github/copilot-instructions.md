# StarDeception Kubernetes Workspace Instructions

## Project Overview

This repository contains Helm charts for the **StarDeception** gaming platform microservices. It supports multiple deployment environments with per-environment configuration overlays, local development via Skaffold + minikube, and automated CI/CD via GitHub Actions.

All container images are hosted on a private Harbor registry at `harbor.dyingstar-game.space/dyingstar/`.

## Environments

| Environment | Namespace | Branch | Deploy Method |
|-------------|-----------|--------|---------------|
| **Production** | `dyingstar-prod` | `main` | GitHub Actions (repository_dispatch from service repos) |
| **Preprod** | `dyingstar-preprod` | `develop` | GitHub Actions (repository_dispatch from service repos) |
| **Dev Shared** | `dyingstar-dev-shared` | — | Manual `helm install` |
| **Dev Local** | `dyingstar-dev-local` | any | Skaffold on minikube |

## Helm Charts

| Chart | Purpose |
|-------|---------|
| `godotserver` | Godot multiplayer game server (headless service) |
| `horizon` | Horizon game server (NodePort, high CPU) |
| `service-resourcesdynamic` | Dynamic resource manager API + WebSocket, with PostgreSQL |
| `dev-services` | Shared developer infrastructure (PostGIS) |

## Conventions

### Chart Structure

Every chart follows the same template structure:
- `Chart.yaml` — chart metadata and appVersion
- `values.yaml` — base configuration values (env-neutral defaults)
- `values-prod.yaml` — production overrides
- `values-preprod.yaml` — preprod overrides
- `values-dev-local.yaml` — local dev overrides (minikube)
- `templates/_helpers.tpl` — shared helper templates (naming, labels, selectors)
- `templates/deployment.yaml`, `service.yaml`, `serviceaccount.yaml` — core resources
- `templates/hpa.yaml` — HorizontalPodAutoscaler (disabled by default)
- `templates/ingress.yaml` — traditional Ingress (disabled by default)
- `templates/httproute.yaml` — Gateway API HTTPRoute (disabled by default)
- `templates/NOTES.txt` — post-install notes
- `templates/tests/test-connection.yaml` — Helm test

### Values Overlay Strategy

Base `values.yaml` contains env-neutral defaults suitable for development. Environment-specific overrides are applied with `-f`:

```bash
# Production
helm upgrade --install -n dyingstar-prod <chart> ./<chart> -f <chart>/values-prod.yaml

# Preprod
helm upgrade --install -n dyingstar-preprod <chart> ./<chart> -f <chart>/values-preprod.yaml

# Local dev
helm upgrade --install -n dyingstar-dev-local <chart> ./<chart> -f <chart>/values-dev-local.yaml
```

Overlay files override only the values that differ per environment:
- `resources.requests/limits` (CPU and memory)
- `replicaCount`
- `image.repository` and `image.pullPolicy`
- `service.nodePort` (for NodePort services like horizon)
- `postgresql.auth.password` (for service-resourcesdynamic)

### Naming & Labels

Use standard Helm helper functions defined in `_helpers.tpl`:
- `{{ include "<chart>.fullname" . }}` for resource names
- `{{ include "<chart>.labels" . }}` for standard Kubernetes labels
- `{{ include "<chart>.selectorLabels" . }}` for pod selectors

Standard labels applied to all resources:
```yaml
helm.sh/chart: <name>-<version>
app.kubernetes.io/name: <chart-name>
app.kubernetes.io/instance: <release-name>
app.kubernetes.io/version: <appVersion>
app.kubernetes.io/managed-by: Helm
```

### Image Configuration

Always use this pattern for container images:
```yaml
image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
imagePullPolicy: {{ .Values.image.pullPolicy }}
```
- **Prod/Preprod**: Harbor images with `IfNotPresent` pull policy
- **Local dev**: Local image name with `Never` pull policy (loaded via `minikube image load`)

### Dockerfiles

Dockerfiles live in each service's own repository, not in this repo:
- `../StarDeception/.docker/Dockerfile` — godotserver
- `../network/.docker/Dockerfile` — horizon
- `../services/resourcesDynamic/docker/Dockerfile` — service-resourcesdynamic

Service repos build and push images to Harbor, then trigger this repo's GitHub Actions for deployment.

### Version Management

Application versions are tracked in `Chart.yaml` via `appVersion`. In CI/CD, images are tagged with the git SHA short hash. For manual deployments, update `appVersion` when deploying a new version.

## When Creating New Charts

1. Copy an existing chart (e.g., `godotserver`) as a template.
2. Update `Chart.yaml` with the new chart name, description, and appVersion.
3. Update `values.yaml` with the correct image repository, ports, and resource limits.
4. Update `_helpers.tpl` — replace the chart name prefix in all helper definitions.
5. Create `values-prod.yaml`, `values-preprod.yaml`, and `values-dev-local.yaml` overlays.
6. Add the service to `skaffold.yaml` (default build + per-service profile).
7. Add the chart name to both GitHub Actions workflow validation lists.
8. Keep probes, autoscaling, ingress, and httproute disabled by default unless needed.

## When Editing Templates

- Use Helm template syntax (`{{ }}`) and follow Go template conventions.
- Wrap optional sections in `{{- if }}` / `{{- end }}` conditionals controlled by `values.yaml`.
- Use `{{- toYaml .Values.<path> | nindent <n> }}` for nested YAML values.
- Preserve consistent indentation (2 spaces for YAML, aligned `nindent` values in templates).
- Test changes with `helm template -n dyingstar-prod <chart> ./<chart> -f <chart>/values-prod.yaml` before deploying.

## Local Development with Skaffold

Skaffold builds images using Dockerfiles from sibling service repos:

```bash
# Deploy all services
skaffold dev

# Deploy a single service
skaffold dev -p horizon
```

Required sibling repos:
- `../StarDeception` — godotserver
- `../network` — horizon
- `../services/resourcesDynamic` — service-resourcesdynamic

## CI/CD

GitHub Actions workflows in `.github/workflows/`:
- `deploy-prod.yaml` — triggered by `repository_dispatch` from service repos, deploys to `dyingstar-prod`
- `deploy-preprod.yaml` — triggered by `repository_dispatch` from service repos, deploys to `dyingstar-preprod`

Service repos trigger deployment after pushing images to Harbor by sending:
```json
{
  "event_type": "deploy-prod",
  "client_payload": {
    "chart": "horizon",
    "image_tag": "abc1234"
  }
}
```

Required GitHub Secrets: `KUBE_CONFIG` (base64-encoded kubeconfig).
