# Keycloak preprod (opérateur)

Ressources Keycloak de **preprod**, réconciliées par l'opérateur upstream
(`keycloak-k8s-resources` `26.7.0`) installé par
[`argocd/preprod/infra/keycloak-app.yaml`](../../argocd/preprod/infra/keycloak-app.yaml),
dans le namespace `keycloak-operator`.

L'opérateur tourne en **cluster-wide** (source upstream `kubernetes/cluster-wide`,
env `JOSDK_ALL_NAMESPACES`) : il observe les CR de **tous** les namespaces. Les
ressources de ce dossier vivent donc dans le namespace du jeu
**`dyingstar-preprod`** (namespace explicite dans chaque manifeste) — au même
endroit que les services applicatifs qui consomment ce Keycloak. Une seconde
instance (prod, namespace `dyingstar-prod`) pourra être ajoutée plus tard sans
nouvelle installation d'opérateur.

C'est l'équivalent preprod de [`keycloak-managed/dev/`](../dev)
(dev-local), en remplacement du chart Helm [`keycloak/`](../keycloak)
(image custom + `start --import-realm`), pour un modèle déclaratif piloté par
l'opérateur.

## Contenu

| Fichier | Rôle |
| --- | --- |
| `00-cnpg-cluster.yaml` | Cluster CloudNativePG `keycloak-db` |
| `03-keycloak.yaml` | CR `Keycloak` (image custom, issuer `https://auth-preprod.dyingstar-game.com`, DB CNPG) |
| `04-realm-import.yaml` | `KeycloakRealmImport` du realm `dyingstar` (33 rôles + launcher + clients `svc-*`) |
| `05-httproute.yaml` | `HTTPRoute` `auth-preprod.dyingstar-game.com` (listener Traefik `keycloak`, HTTPS) |
| `06-service-clients.yaml` | `KeycloakOIDCClient` `svc-*` (`svc-game`, `svc-market`, `svc-inventory`, `svc-mission`, `svc-admin`, `svc-economie` — secrets hors-bande) |
| `07-discord-bootstrap-job.yaml` | Job PostSync : provider Discord via `bootstrap-discord-idp.sh` |
| `08-role-bootstrap-job.yaml` | Job PostSync idempotent : (re)crée les rôles de capacité du realm **et** les mappers d'audience des clients `svc-*` (voir § Wipe) |

## Pré-requis : Secrets hors-bande

Ces Secrets sont créés **à la main** dans le namespace `dyingstar-preprod`
**avant** le premier sync — ils ne sont **jamais** commités (contrairement au
dev-local qui inline des valeurs DEV ONLY). Exécuter avec le contexte preprod :

```bash
CTX=dyingstar   # contexte kubectl du cluster preprod
NS=dyingstar-preprod

# 1. Admin master : compte humain + service account de l'opérateur
kubectl --context "$CTX" -n "$NS" create secret generic keycloak-bootstrap-user \
  --from-literal=username=admin \
  --from-literal=password="$(openssl rand -base64 24)"

# Le service account admin : l'opérateur lit `client-id` / `client-secret`.
# `client-id` DOIT être `operator-admin` (valeur par défaut de l'opérateur) ;
# `client-secret` : valeur hexadécimale indépendante. Pas de caractères
# spéciaux (`+`, `/`, `=`…) : l'opérateur ne les encode pas et Keycloak répond
# `invalid_client_credentials` (401 sur les `KeycloakOIDCClient`).
# Keycloak ne crée `operator-admin` (et l'admin console) que sur un realm
# `master` vide : sur une base migrée, créer le client à la main (confidentiel,
# service account, rôle `admin` de `master`, même secret), puis redémarrer
# l'opérateur pour qu'il relise ce Secret.
kubectl --context "$CTX" -n "$NS" create secret generic keycloak-admin \
  --from-literal=client-id=operator-admin \
  --from-literal=client-secret="$(openssl rand -hex 32)"

# 2. Base de données
kubectl --context "$CTX" -n "$NS" create secret generic keycloak-db-secret \
  --from-literal=username=keycloak \
  --from-literal=password="$(openssl rand -base64 32)"

# 3. Discord (developer portal, redirect URI :
#    https://auth-preprod.dyingstar-game.com/realms/dyingstar/broker/discord/endpoint)
kubectl --context "$CTX" -n "$NS" create secret generic keycloak-discord \
  --from-literal=DISCORD_CLIENT_ID='<id>' \
  --from-literal=DISCORD_CLIENT_SECRET='<secret>'

# 4. Secrets des clients de service (clé `secret`), un par `svc-*`
# + `dyingstar-admin` : client de connexion du panneau d'admin (flow standard)
for c in svc-game svc-market svc-inventory svc-mission svc-admin svc-economie dyingstar-admin; do
  kubectl --context "$CTX" -n "$NS" create secret generic "${c}-client-secret" \
    --from-literal=secret="$(openssl rand -hex 32)"
done
```

Les mêmes secrets client (`svc-*-client-secret`) doivent aussi exister sous les
noms attendus par les charts applicatifs — même namespace (`dyingstar-preprod`)
depuis le déménagement de l'instance, mais noms différents :

| Client Keycloak | Secret applicatif (`dyingstar-preprod`) |
| --- | --- |
| `svc-mission` | `service-mission-mission-client` (clé `secret`) |
| `svc-market` | `service-market-market-client` (clé `secret`) |
| `svc-inventory` | `service-inventory-inventory-client` (clé `secret`) |
| `svc-economie` | `service-economie-economie-client` (clé `secret`) |

Exception : le chart `dyingstar-admin` (panneau d'admin) lit directement
`dyingstar-admin-client-secret` et `svc-admin-client-secret`
(`dyingstar-admin/values-preprod.yaml`) : rien à dupliquer.

### Secret `X-Internal-Key` par service applicatif

Chaque chart `service-*` référence, en `env`, le Secret littéral
`service-<nom>-internal-key` (clé `INTERNAL_API_KEY`) pour lire/envoyer le
header `X-Internal-Key`. En preprod `internalApiKey.create` reste à `false`
(donc le chart ne le crée **pas**) : il doit exister **hors-bande** dans le
namespace applicatif, sinon le pod reste en `CreateContainerConfigError`.

Une **même** valeur est utilisée par tous les services (le header est partagé) :

```bash
NS=dyingstar-preprod
KEY="$(openssl rand -hex 32)"
for s in service-economie service-social service-inventory service-market service-mission; do
  kubectl --context "$CTX" -n "$NS" create secret generic "${s}-internal-key" \
    --from-literal=INTERNAL_API_KEY="$KEY"
done
```

> Ces Secrets ne sont pas liés à Keycloak : ils portent un secret partagé entre
> services, pas une identité `client_credentials`.

## Ordre de réconciliation (sync-waves)

1. `-1` : Cluster CNPG `keycloak-db` (le Secret DB doit déjà exister).
2. `0` : CR `Keycloak`.
3. `1` : `KeycloakRealmImport`.
4. `2` : `KeycloakOIDCClient`.
5. `3` : `HTTPRoute`.
6. `4` (hook PostSync) : Job Discord.
7. `5` (hook PostSync) : Job des rôles de capacité (`08-role-bootstrap-job.yaml`).

## Wipe

Le realm import est **create-only** (`--override=false`) : pour réappliquer une
modification de `04-realm-import.yaml`, il faut repartir d'une base neuve
(supprimer le PVC de `keycloak-db` dans `dyingstar-preprod`). Un wipe complet est
toléré.

> ⚠ Conséquence : ajouter un client (`svc-economie`) ou une audience
> (`inventory-api` / `social-api` sur `svc-market`, `social-api` sur
> `svc-inventory`) **n'a aucun effet** sur un realm déjà importé — hors wipe,
> il faut créer ces objets à la main via `kcadm.sh`, ou repartir de zéro.
> Même comportement en dev-local.
>
> Les **rôles** et les **mappers d'audience** sont en revanche couverts par le
> job PostSync `08-role-bootstrap-job.yaml` : il les recrée (idempotent,
> n'écrase et ne supprime rien) à chaque sync, ce qui évite l'erreur
> `Cannot assign role ... does not exist` sur les CR `KeycloakOIDCClient` et
> les tokens sans audience. Toute nouvelle capacité doit donc être ajoutée à
> `04-realm-import.yaml` **et** à la liste inline du job (mirrors documentés en
> tête du job et dans `import/README.md`).
