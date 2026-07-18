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
├── check-dev.sh                   # Dependency check script
├── start-dev.sh                   # Environment startup script
└── clean-dev.sh                   # Environment cleanup script

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

### Linux / macOS

```bash
# 1. Check dependencies
./check-dev.sh 

# 2. Start the local environment
./start-dev.sh

# 3. Clean up / stop the environment
./clean-dev.sh

```

### Windows

```powershell
# 1. Check dependencies
.\check-dev.ps1 

# 2. Start the local environment
.\start-dev.ps1

# 3. Clean up / stop the environment
.\clean-dev.ps1

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
kubectl apply -f argocd/root-app-dev.yaml

```

### 3. DNS / Hosts File Configuration

Every time the stack is restarted, retrieve the external IP of the Traefik service and update your local `hosts` file (`/etc/hosts` on Linux/Mac, `C:\Windows\System32\drivers\etc\hosts` on Windows).

Example configuration:

```text
10.104.207.169  horizon.dyingstar.local
10.104.207.169  argocd.dyingstar.local

```

### 4. Using Local Docker Images

If you need to build and use local Docker images without pushing them to a registry, point your local Docker daemon to the Minikube Docker environment:

```bash
# Point your terminal to Minikube's docker daemon
eval $(minikube -p minikube docker-env)

# Build your image directly inside Minikube
docker build -t my-project/frontend:local .

```