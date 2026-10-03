# Keycloak preprod (opérateur)

Ressources Keycloak de **preprod**, réconciliées par l'opérateur upstream
(`keycloak-k8s-resources` `26.7.0`) installé par
[`argocd/preprod/infra/keycloak-app.yaml`](../../argocd/preprod/infra/keycloak-app.yaml),
dans le namespace `keycloak`.

C'est l'équivalent preprod de [`keycloak-managed/dev/`](../dev)
(dev-local), en remplacement du chart Helm [`keycloak/`](../keycloak)
(image custom + `start --import-realm`), pour un modèle déclaratif piloté par
l'opérateur.

## Contenu

| Fichier | Rôle |
| --- | --- |
| `00-cnpg-cluster.yaml` | Cluster CloudNativePG `keycloak-db` |
| `03-keycloak.yaml` | CR `Keycloak` (image custom, issuer `https://auth-preprod.dyingstar-game.com`, DB CNPG) |
| `04-realm-import.yaml` | `KeycloakRealmImport` du realm `dyingstar` (30 rôles + launcher + clients `svc-*`) |
| `05-httproute.yaml` | `HTTPRoute` `auth-preprod.dyingstar-game.com` (listener Traefik `keycloak`, HTTPS) |
| `06-service-clients.yaml` | `KeycloakOIDCClient` `svc-*` (secrets hors-bande) |
| `07-discord-bootstrap-job.yaml` | Job PostSync : provider Discord via `bootstrap-discord-idp.sh` |

## Pré-requis : Secrets hors-bande

Ces Secrets sont créés **à la main** dans le namespace `keycloak` **avant** le
premier sync — ils ne sont **jamais** commités (contrairement au dev-local qui
inline des valeurs DEV ONLY). Exécuter avec le contexte preprod :

```bash
CTX=dyingstar   # contexte kubectl du cluster preprod
NS=keycloak

# 1. Admin master : compte humain + service account de l'opérateur
kubectl --context "$CTX" -n "$NS" create secret generic keycloak-bootstrap-user \
  --from-literal=username=admin \
  --from-literal=password="$(openssl rand -base64 24)"

# Le service account admin : l'opérateur lit `client-id` / `client-secret`.
# `client-id` DOIT être `operator-admin` (valeur par défaut de l'opérateur) ;
# `client-secret` = mot de passe ci-dessus.
kubectl --context "$CTX" -n "$NS" create secret generic keycloak-admin \
  --from-literal=client-id=operator-admin \
  --from-literal=client-secret='<le même mot de passe que ci-dessus>'

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
for c in svc-game svc-market svc-inventory svc-mission svc-admin; do
  kubectl --context "$CTX" -n "$NS" create secret generic "${c}-client-secret" \
    --from-literal=secret="$(openssl rand -hex 32)"
done
```

Les mêmes secrets client (`svc-*-client-secret`) doivent être recopiés dans le
namespace applicatif `dyingstar-preprod` sous les noms attendus par les charts :

| Client Keycloak | Secret applicatif (`dyingstar-preprod`) |
| --- | --- |
| `svc-mission` | `service-mission-mission-client` (clé `secret`) |
| `svc-market` | `service-market-market-client` (clé `secret`) |
| `svc-inventory` | `service-inventory-inventory-client` (clé `secret`) |

## Ordre de réconciliation (sync-waves)

1. `-1` : Cluster CNPG `keycloak-db` (le Secret DB doit déjà exister).
2. `0` : CR `Keycloak`.
3. `1` : `KeycloakRealmImport`.
4. `2` : `KeycloakOIDCClient`.
5. `3` : `HTTPRoute`.
6. `4` (hook PostSync) : Job Discord.

## Wipe

Le realm import est **create-only** (`--override=false`) : pour réappliquer une
modification de `04-realm-import.yaml`, il faut repartir d'une base neuve
(supprimer le PVC de `keycloak-db`). Un wipe complet est toléré.
