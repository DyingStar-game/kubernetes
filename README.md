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
| `service-economie` | Economie service API + WebSocket (currencies, wallets, transactions), with PostgreSQL | `../services/economie` |
| `service-social` | Social service API + WebSocket (friends, chat, presence), with PostgreSQL | `../services/social` |
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
│   └── database/                  #   raw manifests: CNPG Cluster (dev-local, ArgoCD 2nd source)
├── keycloak/                      # Helm chart
├── livekit/                       # Helm chart
├── service-persistence/           # Helm chart
├── dev-services/                  # Helm chart (shared dev infra)
├── nextcloud/                     # Helm chart (shared dev infra, 3D asset library)
├── infra/                         # Raw manifests for platform resources (ArgoCD infra apps)
│   └── keycloak/                  # Keycloak dev-local (CR + CNPG Cluster + realm)
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

### Keycloak (dev-local, via Operator)

The dev-local identity provider is **not** the Helm chart anymore: it is a
`Keycloak` custom resource reconciled by the **upstream Keycloak Operator**.
Both the operator and our CRs are declared by a single infra Application,
[`argocd/dev/infra/keycloak-app.yaml`](argocd/dev/infra/keycloak-app.yaml)
(name `keycloak`, project `infra`), with two sources:

- `github.com/keycloak/keycloak-k8s-resources` @ `26.7.0`, path `kubernetes` —
  the operator and its CRDs
- this repo, path [`infra/keycloak/`](infra/keycloak) — our own resources:

| File | Role |
| --- | --- |
| `00-cnpg-cluster.yaml` | PostgreSQL via CloudNativePG (opérateur déjà installé par `argocd/dev/infra/cnpg-op-app.yaml`), PVC 1Gi |
| `01-db-secret.yaml` | Credentials de la base, partagées entre le bootstrap CNPG et la CR Keycloak |
| `02-admin-secret.yaml` | Credentials admin fixes (`admin` / `devpass`) via `spec.bootstrapAdmin` |
| `03-keycloak.yaml` | La CR Keycloak (base, hostname, proxy, ressources) + feature `client-admin-api:v2` requise par les CRs clients |
| `04-realm-import.yaml` | Realm `dyingstar`, rôles de capacité, clients OIDC (dont `svc-*` + mappers d'audience), importé par le job `kcadm` de l'opérateur |
| `05-httproute.yaml` | Exposition via la Gateway Traefik |
| `06-service-clients.yaml` | Clients de service `KeycloakOIDCClient` (`svc-game`, `svc-market`) : `secretRef` + rôles du service account, et leurs Secrets dev (`svc-*-client-secret`) |

Key points:

- **The CR lives in the `keycloak` namespace, not `dyingstar`.** The operator
  Deployment ships with
  `QUARKUS_OPERATOR_SDK_CONTROLLERS_KEYCLOAKCONTROLLER_NAMESPACES=JOSDK_WATCH_CURRENT`,
  i.e. it only reconciles CRs living in its own namespace. Upstream also ships a
  `kubernetes/cluster-wide` kustomization (watches every namespace) — switching
  the infra Application to it would let this CR move to `dyingstar`, at the cost
  of a cluster-scoped operator.
- **One single issuer, with a readable name:**

  ```text
  http://auth.dyingstar.local/realms/dyingstar
  ```

  Same `auth.*` convention as prod (`auth.dyingstar-game.com`) and preprod
  (`auth-preprod.dyingstar-game.com`), in the dev `dyingstar.local` domain. It
  still is a *single* issuer for both callers, thanks to two settings:

  - `spec.hostname.hostname` is a **full URL and static**, so Keycloak only
    resolves scheme/port/context-path dynamically (from `X-Forwarded-*`). A token
    minted by the browser (port 80, through Traefik) and a token validated from a
    pod (port 8080, direct) carry the same `iss`.
  - `spec.hostname.backchannelDynamic: true` resolves the backchannel URLs
    (JWKS, token, userinfo) from the request headers, so an in-cluster caller
    gets internal URLs and never has to resolve `auth.dyingstar.local` (it only
    exists in `/etc/hosts`, via `hosts_config.txt` + `minikube tunnel`). This is
    why the hostname is a full URL — Keycloak requires the scheme.

  `spec.hostname.strict` is left `false`; it is ignored anyway once `hostname` is
  set, and it keeps the operator probes (which reach the server by IP) safe.
- **HTTP, listener `web` (port 80).** The dev Gateway certificate is self-signed
  (`traefik-default-cert`), so terminating TLS here would only add a browser
  warning on every login screen.
- Admin console: <http://auth.dyingstar.local/admin> (`admin` / `devpass`).
  `spec.bootstrapAdmin` only applies to the initial creation of the `master`
  realm: if you change the admin password in the console, this Secret no longer
  has any effect.
- **Three places must stay in sync** when changing the hostname:
  `spec.hostname.hostname` (03), `hostnames` (05) and `hosts_config.txt`.
- DEV ONLY credentials everywhere (`admin` / `devpass`, `keycloak` / `keycloak`,
  `devplayer` / `devplayer`, `dyingstar-service`). Same rule as
  `keycloak/values-dev.yaml`: never reuse them anywhere else.

Health check:

```bash
kubectl get cluster -n keycloak                        # keycloak-db  1/1 Ready
kubectl get keycloak,keycloakrealmimport -n keycloak   # Ready=True
kubectl get httproute keycloak -n keycloak              # Accepted=True
curl -sI http://auth.dyingstar.local/realms/dyingstar/.well-known/openid-configuration
```

> **One-off cleanup.** Before this setup, the dev and the infra roots both
> declared an Application named `keycloak-operator-official`, which cannot
> coexist. There is now a single `keycloak` Application. If the old name lingers
> (or after a `git revert`), delete it once by hand:
> `kubectl delete application keycloak-operator-official -n argocd`.

### Keycloak — service identities (machine-to-machine, `client_credentials`)

The game server does not present a shared secret anymore: it asks Keycloak for a
token at
`POST /realms/dyingstar/protocol/openid-connect/token` with
`grant_type=client_credentials`, `client_id`, `client_secret`, and sends
`Authorization: Bearer <access_token>`. The APIs `economie` / `social` validate
that JWT against the realm JWKS and accept it only if `azp` is an allow-listed
client and `aud` targets their own API. **The realm-side contract below is coded
in the APIs; never rename any of it.**

| clientId | `aud` in the access token | realm roles on the service account |
| --- | --- | --- |
| `svc-game` | `economie-api`, `social-api`, `mission-api` | the 16 capacity roles |
| `svc-market` | `economie-api` | `economie:wallet:read`, `economie:wallet:credit`, `economie:wallet:debit` |
| `svc-mission` | `economie-api`, `social-api` | `economie:wallet:read`, `economie:wallet:credit`, `economie:wallet:debit`, `social:corporation:read` |

The 16 realm roles (no realm prefix):

```text
economie:wallet:read  economie:wallet:ensure  economie:wallet:credit  economie:wallet:debit
economie:corporation:read  economie:corporation:manage
social:profile:write  social:player:write  social:corporation:read
social:corporation:write  social:sanctions:read  social:reputation:write
mission:read  mission:write  mission:complete  mission:manage
```

#### Which CRD does what (verified against the deployed operator)

The operator is `keycloak-k8s-resources` @ `26.7.0`; its CRDs are:

```bash
kubectl api-resources | grep keycloak
# keycloaks, keycloakrealmimports, keycloakoidcclients, keycloaksamlclients
```

There is **no** `KeycloakUser` / `KeycloakGroup` / realm-role kind. The clients
are therefore split across two CRs by capability:

| Concern | CRD | File |
| --- | --- | --- |
| Realm roles, clients, audience mappers | `KeycloakRealmImport` | `04-realm-import.yaml` |
| Client secret (`auth.secretRef`), service-account roles (`serviceAccountRoles`) | `KeycloakOIDCClient` (v2alpha1) | `06-service-clients.yaml` |

The `KeycloakOIDCClient` controller refuses to reconcile unless the Keycloak CR
enables the `client-admin-api:v2` feature (`03-keycloak.yaml`): without it the
CRs stay `NotReady` and the `svc-*` clients keep Keycloak's auto-generated
secret, so `client_credentials` fails with `unauthorized_client`.

Two consequences worth knowing:

- **No `kcadm` Job is needed for role assignment** — `KeycloakOIDCClient` exposes
  `spec.client.serviceAccountRoles`. It is only the audience mapper (and the
  realm-level token lifespan) that `KeycloakOIDCClient` cannot express, hence the
  client is declared in both CRs: the realm import owns the mappers/scopes, the
  `KeycloakOIDCClient` owns the secret and the role bindings. A `kcadm` Job would
  be needed only if a future operator dropped `serviceAccountRoles`; it would
  then have to be idempotent (`kcadm update ...` + reconcile).
- **Per-client access-token lifespan is not exposed by either CRD.** The 300 s
  window is set at the realm level (`accessTokenLifespan: 300` in
  `04-realm-import.yaml`), currently already the case in dev-local. The
  preprod/prod realm ships from the `../services/keycloak` image and is outside
  this repository — align it there separately.

#### Secrets

Each service reads its secret from a Kubernetes Secret referenced by
`spec.client.auth.secretRef`. **Outside dev**, that Secret is created **out of
band**, one per environment, and never committed:

```bash
# Once per environment, BEFORE the KeycloakOIDCClient is reconciled:
kubectl -n keycloak create secret generic svc-game-client-secret \
  --from-literal=secret="$(openssl rand -hex 32)"
kubectl -n keycloak create secret generic svc-market-client-secret \
  --from-literal=secret="$(openssl rand -hex 32)"
```

**En dev-local**, pour que la stack soit auto-portante (mêmes valeurs en clair que
`01-db-secret.yaml` / `02-admin-secret.yaml`), les deux Secrets sont livrés par
`06-service-clients.yaml` (sync-wave `-1`), donc `verify-service-auth.sh` les
trouve sans étape manuelle. Les valeurs sont locales au minikube — DEV ONLY.

The **game server** stores the same values in its own per-env secret manager
(sealed-secret / external-secret / SOPS); only the client secret is needed, no
other shared secret.

#### Add a new service

1. Realm roles: add the new `*.realm` roles in `04-realm-import.yaml` (exact
   names, no `/realm` prefix).
2. Audience: declare the client in `04-realm-import.yaml` with
   `serviceAccountsEnabled: true` (browser flows off) and one
   `oidc-audience-mapper` per target API; add the target API's audience to the
   other services if needed.
3. Secret: create `<clientId>-client-secret` (key `secret`) out of band.
4. Identity: add a `KeycloakOIDCClient` in `06-service-clients.yaml`
   (`loginFlows: [SERVICE_ACCOUNT]`, `auth.secretRef`, `serviceAccountRoles`).
5. API side (outside this repo): add the clientId to `INTERNAL_SERVICE_CLIENTS`
   and, if it is a new API, set `OIDC_SERVICE_AUDIENCE`.

#### Revoke or rotate

- **Revoke**: set `spec.client.enabled: false` on the `KeycloakOIDCClient` (or
  delete the CR). New tokens stop being issued immediately; **tokens already
  issued stay valid for at most 300 s**, which is the whole point of the short
  lifespan.
- **Rotate**: re-render the Secret (`kubectl create secret ... --dry-run=client
  -o yaml | kubectl apply -f -`, or your manager's rotate command). The operator
  picks up the change via `secretRef`; the old secret is invalid on the next
  token request, and already-issued tokens again expire within 300 s.

#### Values to report to the APIs, per environment

| Env | Issuer (`OIDC_ISSUER`) | `OIDC_SERVICE_AUDIENCE` | `INTERNAL_SERVICE_CLIENTS` |
| --- | --- | --- | --- |
| dev-local | `http://auth.dyingstar.local/realms/dyingstar` | `economie-api` / `social-api` / `mission-api` | `svc-game,svc-market,svc-mission` |
| preprod | `https://auth-preprod.dyingstar-game.com/realms/dyingstar` | `economie-api` / `social-api` / `mission-api` | `svc-game,svc-market,svc-mission` |
| prod | `https://auth.dyingstar-game.com/realms/dyingstar` | `economie-api` / `social-api` / `mission-api` | `svc-game,svc-market,svc-mission` |

`OIDC_SERVICE_AUDIENCE` is per API (economie / social / mission); `INTERNAL_SERVICE_CLIENTS`
is the allowlist of callers for all of them. **A clientId absent from `INTERNAL_SERVICE_CLIENTS`
is rejected with `403 SERVICE_FORBIDDEN`**, and a token whose `aud` does not match
the API is rejected as well. The player client (`dyingstar-game`) carries
`azp = dyingstar-game`, which is never in the allowlist: player tokens are never
accepted on `/api/internal/*`.

In the charts, both values are rendered from `service-<name>/values-dev.yaml`
(`oidc.serviceAudience`, `internalServiceClients`); preprod/prod overlays set the
same two keys. Run the assertions with
[`scripts_linux/verify-service-auth.sh`](scripts_linux/verify-service-auth.sh).

### Databases (dev-local, via CloudNativePG)

The dev-local stack does not let application charts declare their own PostgreSQL
anymore: databases are reconciled by the
[CloudNativePG operator](https://cloudnative-pg.io/) installed by
`argocd/dev/infra/cnpg-op-app.yaml` (namespace `cnpg-system`), and the consumers
point at them with `database.host` / `database.existingSecret`.

Each database belongs to the Application that needs it, so it travels with it:

| Cluster | Namespace | Database / owner | Manifests | ArgoCD app (project) | Consumer |
| --- | --- | --- | --- | --- | --- |
| `keycloak-db` | `keycloak` | `keycloak` | [`infra/keycloak/`](infra/keycloak) | `keycloak` (infra) | `Keycloak` CR (`spec.db`) |
| `resourcesdynamic-db` | `dyingstar` | `resources_dynamic` | [`service-resourcesdynamic/database/`](service-resourcesdynamic/database) | `service-resourcesdynamic` (game) | `service-resourcesdynamic` (`database.host`) |
| `economie-db` | `dyingstar` | `economie` | [`service-economie/database/`](service-economie/database) | `service-economie` (game) | `service-economie` (`database.host`) |
| `social-db` | `dyingstar` | `social` | [`service-social/database/`](service-social/database) | `service-social` (game) | `service-social` (`database.host`) |
| `mission-db` | `dyingstar` | `mission` | [`service-mission/database/`](service-mission/database) | `service-mission` (game) | `service-mission` (`database.host`) |

`service-resourcesdynamic/database/` is a **second source** of the game
Application, not a Helm template: the chart and its database are reconciled in
one sync. `service-resourcesdynamic` is a game service, so its database is
declared in the game tree — unlike Keycloak, which is an auth platform and lives
in the infra tree. Same layout for `service-economie/database/` and
`service-social/database/`. (The `argocd/dev/game/` directory itself only holds
`Application` objects: `root-game` scans it, so manifests must not be dropped
there.)

Conventions:

- A Cluster is named `<service>-db`; CloudNativePG then exposes the
  `<service>-db-rw` Service, which is what the consumer connects to.
- Credentials are declared in the repo next to the Cluster (DEV ONLY) and used
  twice: `bootstrap.initdb.secret` on the Cluster, and the consumer Secret
  (`database.existingSecret`). The password key is always `password`.
- Dev-local databases have a 1Gi PVC. They used to be `emptyDir` in some charts,
  so data now survives `minikube stop` — a behaviour change, not a regression.

```bash
kubectl get clusters.postgresql.cnpg.io -A              # both 1/1 Ready
kubectl get pods -n dyingstar -l cnpg.io/cluster=resourcesdynamic-db
```

**Still not on CloudNativePG** (deliberately, out of scope for dev-local):
`service-persistence` (ScyllaDB), `nextcloud` + `livekit` (Redis), the
`dev-shared` namespace (PostGIS 50Gi, Nextcloud PostgreSQL 10Gi — no ArgoCD, and
no CNPG operator on the `dyingstar` cluster yet), and Harbor's internal database
in preprod.

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
`resourcesdynamic`, `economie`, `social`, `persistence`, `monitoring`) are
declared in [`dev-projects.yaml`](dev-projects.yaml).

A target may declare a `hook`: `scripts_linux/hooks/<hook>.sh` (or
`scripts_windows/hooks/<hook>.ps1`) runs with `prepare` before the `docker build` and
`cleanup` after it (always, even on failure). This is where the source tweaks the CI
applies before building are replayed locally. Set `NO_CACHE=1` to build with
`docker build --no-cache` like the CI does.

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

#### Build the godot server image locally

To run your local godot sources as a pod in minikube (instead of the `develop` image
from Harbor, or the editor `F5` run above):

```bash
./scripts_linux/build-and-deploy.sh godotserver
GODOT_STREAM_CHANNEL=preprod ./scripts_linux/build-and-deploy.sh godotserver   # same [stream] channel as preprod
```

The `godotserver` hook replays the steps of `DyingStar/.github/workflows/build-server-preprod.yaml`
on the `../DyingStar` sources before the build, then restores the files (your uncommitted
changes are kept):

- `scenes/globals/globals.gd`: dev tools (`spawn_wheel`, `zapette`, `toggle_eva`,
  `build_chunk_skirts`) switched OFF, with the same check as the CI;
- `server.ini`: `[stream] channel` set to `GODOT_STREAM_CHANNEL` (default `dev`; the
  preprod CI uses `preprod`);
- `assets_blender/` is already excluded by `.dockerignore`, nothing to do.

The build is long (Godot import + export + `dotnet publish`, several minutes) and needs
a lot of disk space in the minikube VM.

To run several game server instances (the ArgoCD dev Application ignores `replicas`,
like the image, so this survives the reconcile; `values-dev.yaml` stays at 1):

```bash
kubectl scale deployment godotserver -n dyingstar --replicas=6
```

Every godotserver pod shares the same tile cache and prebaked collision shapes
(`sharedCache` in `godotserver/values*.yaml`): one ReadWriteMany PVC
(`godotserver-shared-cache`) is mounted with a `subPath` on
`user://tile_cache` and `user://prebaked_collision`, so a pod scaled up for
dynamic server meshing starts with what the others already streamed/baked
instead of redoing it. The PVC is `helm.sh/resource-policy: keep`: delete it by
hand to wipe the cache. On minikube the hostpath `standard` class is enough. On
the `dyingstar` cluster the only dynamic class (`local-path`) is ReadWriteOnce
only, so preprod/prod use a **static NFS PV on TrueNAS** (`sharedCache.nfs`,
same pattern as the nextcloud chart): before enabling it, create the dataset and
NFS share on TrueNAS with the settings of [nextcloud/README.md §1](nextcloud/README.md)
(Maproot = root, node subnet only) at the `sharedCache.nfs.path` of the
environment (`/mnt/storage1/dyingstar/godotserver-preprod` / `-prod`).

#### Develop Horizon

Clone [horizonserver](https://github.com/DyingStar-game/horizonserver) next to this
repository, then build the part you modified:

```bash
./scripts_linux/build-and-deploy.sh horizon           # the server itself (Horizon/ workspace)
./scripts_linux/build-and-deploy.sh horizon-plugins   # the plugins .so (ds_*/ crates)
./scripts_linux/build-and-deploy.sh horizon-data      # the ds_genericprops JSON files + .docker/plugins.toml
```

`plugins.toml` (split/merge rules, bridges, log levels…) ships in `horizon-data`, not in
the plugins image: after editing it, rebuild `horizon-data`, not `horizon-plugins`.

**NOTE**: you can mix this chapter and previous chapter if you made modifications in
godotserver and horizon in same time!

#### Develop service Resourcesdynamic

```bash
./scripts_linux/build-and-deploy.sh resourcesdynamic
```

#### Develop service Economie

```bash
./scripts_linux/build-and-deploy.sh economie
```

#### Develop service Social

```bash
./scripts_linux/build-and-deploy.sh social
```

---

## Shared Dev Services

Shared infrastructure for all developers, deployed on the main cluster.

**PostGIS** (chart `dev-services`), available via NodePort (default `30432`).
Its credentials live in a Kubernetes Secret managed outside Helm
(`postgis-auth`, keys `username` / `password`), referenced by
`postgis.auth.existingSecret`:

```bash
helm upgrade --install --kube-context=dyingstar -n dyingstar-dev-shared \
  dev-services ./dev-services -f dev-services/values-dev-shared.yaml
```

Why not a chart value: PostgreSQL only honours `POSTGRES_USER` and
`POSTGRES_PASSWORD` during the initial `initdb`. Once the PVC holds a database, a
credential regenerated by `helm upgrade` never reaches PostgreSQL — the role that
exists keeps working while the Secret quietly stops matching it, and the next
person to trust the Secret is stuck.

<details>
<summary>One-off migration of the running release</summary>

The deployed release predates this: it carries no user-supplied values and was
installed when `values.yaml` still held the real credentials, which were
sanitised in git afterwards. Copy what the cluster actually runs into the new
Secret **before** upgrading — the old chart-managed `dev-services-postgis` Secret
is pruned by the upgrade.

This is the one step that restarts the database: the credentials move from a
literal env value to a `secretKeyRef`, which is a pod-template change. Applying
`strategy: Recreate` first makes that rollout safe on a single-node cluster —
`strategy` is not part of the pod template, so the patch itself restarts nothing.

```bash
NS=dyingstar-dev-shared; KC=--context=dyingstar

# 1. What the database actually uses today
PGUSER=$(kubectl $KC -n $NS get deploy dev-services-postgis \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="POSTGRES_USER")].value}')
PGPASS=$(kubectl $KC -n $NS get secret dev-services-postgis \
  -o jsonpath='{.data.password}' | base64 -d)
echo "user=$PGUSER"

# 2. The out-of-band Secret, under a NEW name (the old one belongs to Helm)
kubectl $KC -n $NS create secret generic postgis-auth \
  --from-literal=username="$PGUSER" \
  --from-literal=password="$PGPASS"

# 3. Make the coming rollout safe
kubectl $KC -n $NS patch deploy dev-services-postgis \
  --type=merge -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'

# 4. Upgrade — PostGIS restarts once here
helm upgrade --install --kube-context=dyingstar -n $NS \
  dev-services ./dev-services -f dev-services/values-dev-shared.yaml
kubectl $KC -n $NS rollout status deploy/dev-services-postgis --timeout=10m

# 5. Confirm the role still authenticates
kubectl $KC -n $NS exec deploy/dev-services-postgis -- \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select current_user"'
```

</details>

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
- **Database**: CloudNativePG in dev-local, bundled PostgreSQL in preprod/prod
  (the chart only sets `postgresql.enabled: false` for dev — see
  [Databases (dev-local)](#databases-dev-local-via-cloudnativepg))
- Environment variable `DATABASE_URL` is auto-configured from chart values

### Service Economie
- **Ports**: 3000 (HTTP API), 9200 (WebSocket). No `PORT` env var is injected:
  `service.port` must stay equal to the app's own default
- **Database**: CloudNativePG `economie-db` in dev-local, bundled PostgreSQL in
  preprod/prod (the chart only sets `postgresql.enabled: false` for dev — see
  [Databases (dev-local)](#databases-dev-local-via-cloudnativepg))
- **Dev hostname**: `economie.dyingstar.local` (Traefik HTTPRoute)
- **Env**: `POSTGRES_*` and `DATABASE_URL` are generated by the Deployment
  template from `database`; `OIDC_ISSUER` comes from the per-environment `oidc`
  block (empty by default); `INTERNAL_API_KEY` is read from the Secret
  `service-economie-internal-key`, created by the chart in dev from
  `internalApiKey.key`; the rest (`NODE_ENV`, `CORS_ORIGIN`,
  `AUTH_DEV_BYPASS`, `ECONOMY_*`) lives in `env` in `values.yaml`

### Service Social
- **Ports**: 3000 (HTTP API), 9200 (WebSocket). No `PORT` env var is injected:
  `service.port` must stay equal to the app's own default
- **Database**: CloudNativePG `social-db` in dev-local, bundled PostgreSQL in
  preprod/prod (the chart only sets `postgresql.enabled: false` for dev — see
  [Databases (dev-local)](#databases-dev-local-via-cloudnativepg))
- **Dev hostname**: `social.dyingstar.local` (Traefik HTTPRoute)
- **Env**: `POSTGRES_*` and `DATABASE_URL` are generated by the Deployment
  template from `database`; `OIDC_ISSUER` comes from the per-environment `oidc`
  block (empty by default); `INTERNAL_API_KEY` is read from the Secret
  `service-social-internal-key`, created by the chart in dev from
  `internalApiKey.key`; the rest (`NODE_ENV`, `CORS_ORIGIN`, `AUTH_DEV_BYPASS`,
  `REPUTATION_*`) lives in `env` in `values.yaml`

### Service Mission
- **Ports**: 3000 (HTTP API), 9200 (WebSocket). Unlike economie/social, the
  service reads `PORT` itself, so the chart injects `PORT={{ .Values.service.port }}`
- **Database**: CloudNativePG `mission-db` in dev-local, bundled PostgreSQL in
  preprod/prod (the chart only sets `postgresql.enabled: false` for dev — see
  [Databases (dev-local)](#databases-dev-local-via-cloudnativepg))
- **Dev hostname**: `mission.dyingstar.local` (Traefik HTTPRoute)
- **Caller**: only the game server (`svc-game`) is allow-listed on
  `/api/internal/*` (`internalServiceClients`), with `OIDC_SERVICE_AUDIENCE=mission-api`
- **Calls out** as the `svc-mission` Keycloak service account (client_credentials,
  audience `economie-api` + `social-api`): `ECONOMY_API_URL` to pay rewards and
  `SOCIAL_API_URL` to verify corporation membership. The client secret is read
  from the Secret `service-mission-mission-client` (key `secret`), created by the
  chart in dev from `serviceClient.clientSecret`; it must equal
  `svc-mission-client-secret` in `infra/keycloak/06-service-clients.yaml`
- **Env**: `POSTGRES_*` / `DATABASE_URL`, `OIDC_*`, `INTERNAL_SERVICE_CLIENTS`,
  `ECONOMY_*`, `SOCIAL_*` and `PORT` are rendered by the Deployment template;
  `INTERNAL_API_KEY` comes from the Secret `service-mission-internal-key`; the
  rest (`NODE_ENV`, `CORS_ORIGIN`, `AUTH_DEV_BYPASS`, `INTERNAL_DEV_BYPASS`,
  `MISSION_*`) lives in `env` in `values.yaml`

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
