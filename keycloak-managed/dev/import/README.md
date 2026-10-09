# DyingStar Keycloak

Custom Keycloak distribution for the DyingSTar game.

This repository owns:
- the **Docker image** published to `harbor.dyingstar-game.space/dyingstar/keycloak`,
- the **realm definition** (`realm/dyingstar-realm.json`) imported on every Keycloak start,
- the **Discord IdP bootstrap script** (`scripts/bootstrap-discord-idp.sh`) executed by the Helm post-install Job in the [kubernetes](../../kubernetes/keycloak) repo.

The Helm chart that consumes this image lives in `../../kubernetes/keycloak/`.

## Layout

```
docker/Dockerfile                      # FROM quay.io/keycloak/keycloak:<pinned>
realm/dyingstar-realm.json             # Imported by `start --import-realm`
scripts/bootstrap-discord-idp.sh       # kcadm.sh-based, idempotent
.github/workflows/build-and-deploy.yaml
```

## Build locally

```bash
docker build -t keycloak:dev -f docker/Dockerfile .
```

## Realm export workflow

When admins make changes through the Keycloak UI in prod/preprod, they drift
from `realm/dyingstar-realm.json`. To re-sync:

```bash
kubectl -n dyingstar-prod exec deploy/keycloak -- \
  /opt/keycloak/bin/kc.sh export --dir /tmp/export --realm dyingstar
kubectl -n dyingstar-prod cp keycloak-<pod>:/tmp/export/dyingstar-realm.json \
  realm/dyingstar-realm.json
```

Review the diff carefully before committing — the Discord IdP block should
stay empty in git (secrets are never exported into the realm JSON).

## Discord setup

1. Create an OAuth2 application on https://discord.com/developers/applications
2. Add the redirect URI for each environment:
   - prod:    `https://auth.dyingstar-game.com/realms/dyingstar/broker/discord/endpoint`
   - preprod: `https://auth-preprod.dyingstar-game.com/realms/dyingstar/broker/discord/endpoint`
   - local:   `http://<minikube-ip>:30180/realms/dyingstar/broker/discord/endpoint`
3. Store the client_id / client_secret in the cluster Secret `keycloak-discord`
   in each target namespace (or inline them in `values-dev-local.yaml` for local dev).

## Service capability roles

Internal service-to-service calls are authorised by **client roles** on each service's API
client (realm `dyingstar`), granted to the `svc-*` service accounts. The realm JSON in `realm/`
does not carry these clients/roles (they are managed through the Keycloak UI); keep this list in
sync with each service's `src/middleware/auth.ts` `SERVICE_ROLES`.

### social (`social-api`)
| Role | Grants |
|---|---|
| `social:profile:read` | Profile lookup / pseudonym resolution |
| `social:profile:write` | Login profile upsert, NPC profile upsert, presence |
| `social:player:write` | Game stats and activity |
| `social:corporation:read` | Corporation membership reads |
| `social:corporation:write` | NPC corporation membership + internal corporation/CEO management |
| `social:group:read` | Group membership reads (temporary groups: player group, group summary) |
| `social:politics:read` | Political membership reads |
| `social:politics:write` | NPC political membership + internal political entity management |
| `social:sanctions:read` | Active sanctions (mute/ban enforcement) |
| `social:reputation:write` | Reputation adjustments and rehabilitation passes |
| `social:authorize` | Central ACL: `POST /api/internal/authorize` + permission catalog |

### economie (`economie-api`)
| Role | Grants |
|---|---|
| `economie:wallet:read` | Wallet/ledger reads (player, NPC, corporation, political) |
| `economie:wallet:ensure` | Lazy account creation |
| `economie:wallet:credit` / `economie:wallet:debit` | Single-sided money movements |
| `economie:corporation:read` / `economie:corporation:manage` | Corporate treasury membership, settings, affiliation |
| `economie:politics:read` / `economie:politics:manage` | Political treasury, settings, tax assessment, NPC tax payment |
| `economie:money:issue` | Currency issuance (mint) into a country/federation treasury |

### inventory (`inventory-api`)
| Role | Grants |
|---|---|
| `inventory:read` | Holder inventory / instance reads |
| `inventory:credit` | Credit/debit stacks and instances |
| `inventory:transfer` | Transfers (stacks, instances, hold consumption) |
| `inventory:hold` | Reserve (hold) and release items |
| `inventory:corporation:manage` | *(declared, not yet wired to a route)* |
| `inventory:poi:manage` | Create/edit/delete POIs on the internal API |

### mission (`mission-api`)
| Role | Grants |
|---|---|
| `mission:read` | List missions / player missions |
| `mission:write` | Create, update, expire, cancel, assign missions |
| `mission:progress` | Objective progress |
| `mission:complete` | Complete and settle missions |

### market (`market-api`)
| Role | Grants |
|---|---|
| `market:read` | Catalog, orders, demands, trades reads |
| `market:manage` | Catalog management, place/cancel orders and demands |
| `market:settle` | Settle trades |

> When adding a capability, create the client role on the target `*-api` client and assign it to
> the calling `svc-*` service account. The game server (`svc-game`) typically needs the write
> roles: `social:corporation:write`, `social:politics:write`, `economie:wallet:*`,
> `economie:politics:*`, `inventory:*`, `mission:*` and `market:*`.
>
> A new role must be declared in **three** places: this table (naming authority),
> `spec.realm.roles` of `04-realm-import.yaml` (dev **and** preprod), and the inline
> list of `07-role-bootstrap-job.yaml` (dev) / `08-role-bootstrap-job.yaml` (preprod).
> The realm import is create-only (`--override=false`): on an already-imported realm
> it is the PostSync job that actually creates the role — without it the
> `KeycloakOIDCClient` reconciliation fails with
> `Cannot assign role ... does not exist`.
>
> The same create-only gap applies to the **audience mappers** declared in the
> `protocolMappers` of each `svc-*` client in `04-realm-import.yaml`: they must
> also be mirrored in the `CLIENT_AUD` table of that same job, otherwise the
> token ships without `aud` for the called API and the resource server answers
> 401 before any role check.
>
> The mission service (`svc-mission`) needs, on top of the write roles it already uses:
> `social:corporation:read`, `social:group:read`, `social:profile:read` (prereq `min_reputation`)
> on `social-api`, `economie:wallet:read` on `economie-api` (prereq/objective `has_credits`),
> and `inventory:read` on `inventory-api` (objectives `owns_items` / `deliver_items`). The
> `inventory-api` audience must therefore be mapped on its client too.
>
> The market service (`svc-market`) needs `economie:wallet:read/credit/debit` on
> `economie-api` (settlement), `inventory:read` + `inventory:hold` + `inventory:transfer` on
> `inventory-api` (order escrow) and `social:corporation:read` + `social:group:read` +
> `social:profile:read` on `social-api` (corporation-scoped orders). Its client carries the
> `economie-api`, `inventory-api` and `social-api` audiences — and never `market-api`.
>
> The inventory service (`svc-inventory`) needs `economie:wallet:read/credit/debit` on
> `economie-api` (stock movements) and `social:corporation:read` + `social:group:read` +
> `social:profile:read` on `social-api` (corporation deposits/withdrawals). Its client
> carries `economie-api` + `social-api` — and never `inventory-api`.
>
> The economy service (`svc-economie`) only calls `social-api`, for
> `social:corporation:read` + `social:group:read` + `social:profile:read` (corporation and
> political treasuries). Its client carries `social-api` only.

## Admin panel (`dyingstar-admin`)

The admin panel ([DyingStar-game/adminpanel](https://github.com/DyingStar-game/adminpanel), chart
`dyingstar-admin`) signs people in through the confidential client `dyingstar-admin` (standard
flow + PKCE), declared by the `KeycloakOIDCClient` CRs of `keycloak-managed/{dev,preprod}/06-service-clients.yaml`.
Its machine calls go through `svc-admin` (above).

- **Realm roles** `moderator` < `admin` < `supervisor`: moderation levels, checked by the services'
  Admin routes and by the panel.
- **Client roles** of `dyingstar-admin`, given to people (Users › Role mapping): `persistence:read`,
  `persistence:write`, `persistence:delete`, `social:corporation:write`, `social:politics:write`,
  `economie:wallet:read`, `economie:wallet:credit`, `economie:wallet:debit`,
  `economie:politics:read`, `economie:politics:manage`, `economie:corporation:read`,
  `economie:corporation:manage`, `economie:money:issue`. The panel's list (its ADR 0023) is the
  authority for these names.

## Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `HARBOR_USERNAME` / `HARBOR_PASSWORD` | Push image to Harbor |
| `KUBERNETES_REPO_TOKEN` | Fine-grained PAT to trigger `repository_dispatch` on the kubernetes repo |
