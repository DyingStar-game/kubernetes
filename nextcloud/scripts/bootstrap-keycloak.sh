#!/usr/bin/env bash
#
# Bootstrap the Keycloak side of the Nextcloud login: a dedicated realm, the
# `nextcloud` OIDC client, a `groups` claim, the two DyingStar groups and the
# GitHub identity provider.
#
# Everything runs through kcadm.sh *inside* the Keycloak pod, so the only local
# dependency is kubectl. The script is idempotent — re-run it after changing a
# variable and it updates in place.
#
# Usage:
#   GITHUB_CLIENT_ID=xxx GITHUB_CLIENT_SECRET=yyy ./nextcloud/scripts/bootstrap-keycloak.sh
#
# Create the GitHub OAuth App first (https://github.com/settings/developers,
# or in the DyingStar org settings), with the callback URL printed at the end of
# this script.
#
set -euo pipefail

KUBE_CONTEXT="${KUBE_CONTEXT:-dyingstar}"
KC_NAMESPACE="${KC_NAMESPACE:-dyingstar-dev-shared}"
KC_RELEASE="${KC_RELEASE:-keycloak}"
KC_ADMIN_SECRET="${KC_ADMIN_SECRET:-keycloak-admin}"
KC_PUBLIC_URL="${KC_PUBLIC_URL:-https://auth.dev.dyingstar-game.space}"

REALM="${REALM:-dyingstar-studio}"
REALM_DISPLAY_NAME="${REALM_DISPLAY_NAME:-DyingStar Studio}"
CLIENT_ID="${CLIENT_ID:-nextcloud}"
NEXTCLOUD_URL="${NEXTCLOUD_URL:-https://cloud.dev.dyingstar-game.space}"
WRITE_GROUP="${WRITE_GROUP:-ds-modelers}"
READ_GROUP="${READ_GROUP:-ds-viewers}"

: "${GITHUB_CLIENT_ID:?set GITHUB_CLIENT_ID (GitHub OAuth App client id)}"
: "${GITHUB_CLIENT_SECRET:?set GITHUB_CLIENT_SECRET (GitHub OAuth App client secret)}"

# Generated locally so we can hand it to the Nextcloud Secret without reading it
# back out of Keycloak. Pass your own to keep an existing one.
CLIENT_SECRET="${CLIENT_SECRET:-$(openssl rand -hex 32)}"

KUBECTL=(kubectl --context="${KUBE_CONTEXT}" -n "${KC_NAMESPACE}")

echo "==> Reading the Keycloak admin credentials from secret/${KC_ADMIN_SECRET}"
KC_ADMIN_USER=$("${KUBECTL[@]}" get secret "${KC_ADMIN_SECRET}" -o jsonpath='{.data.KEYCLOAK_ADMIN}' | base64 -d)
KC_ADMIN_PASSWORD=$("${KUBECTL[@]}" get secret "${KC_ADMIN_SECRET}" -o jsonpath='{.data.KEYCLOAK_ADMIN_PASSWORD}' | base64 -d)

# Target the server pod by label rather than `exec deploy/keycloak`: the bundled
# PostgreSQL and the bootstrap Job carry the same name/instance labels, so a
# deployment reference can resolve to the wrong pod.
echo "==> Locating the Keycloak server pod"
KC_POD=$("${KUBECTL[@]}" get pod \
  -l "app.kubernetes.io/name=keycloak,app.kubernetes.io/instance=${KC_RELEASE},app.kubernetes.io/component=server" \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

if [ -z "${KC_POD}" ]; then
  echo "ERROR: no running pod with component=server for release ${KC_RELEASE} in ${KC_NAMESPACE}." >&2
  echo "       If this release predates the selector fix, its pods carry no" >&2
  echo "       app.kubernetes.io/component label yet. Recreate the Deployment:" >&2
  echo "         kubectl --context=${KUBE_CONTEXT} -n ${KC_NAMESPACE} delete deploy ${KC_RELEASE}" >&2
  echo "         helm upgrade --install --kube-context=${KUBE_CONTEXT} -n ${KC_NAMESPACE} \\" >&2
  echo "           ${KC_RELEASE} ./keycloak -f keycloak/values-dev-shared.yaml --reuse-values" >&2
  exit 1
fi

if ! "${KUBECTL[@]}" exec "${KC_POD}" -- test -x /opt/keycloak/bin/kcadm.sh 2>/dev/null; then
  echo "ERROR: /opt/keycloak/bin/kcadm.sh not found in pod ${KC_POD}." >&2
  echo "       That pod is not a Keycloak server. Check the labels above." >&2
  exit 1
fi

echo "==> Running kcadm inside ${KC_POD} (realm ${REALM})"
"${KUBECTL[@]}" exec -i "${KC_POD}" -- env \
  KC_ADMIN_USER="${KC_ADMIN_USER}" \
  KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD}" \
  REALM="${REALM}" \
  REALM_DISPLAY_NAME="${REALM_DISPLAY_NAME}" \
  CLIENT_ID="${CLIENT_ID}" \
  CLIENT_SECRET="${CLIENT_SECRET}" \
  NEXTCLOUD_URL="${NEXTCLOUD_URL}" \
  WRITE_GROUP="${WRITE_GROUP}" \
  READ_GROUP="${READ_GROUP}" \
  GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID}" \
  GITHUB_CLIENT_SECRET="${GITHUB_CLIENT_SECRET}" \
  bash -s <<'REMOTE'
set -euo pipefail
KCADM=/opt/keycloak/bin/kcadm.sh

# Reads a `--fields id,name --format csv --noquotes` listing on stdin and prints
# the id of the row whose name matches $1. Pure bash on purpose: the Keycloak
# image ships neither awk nor jq.
csv_id_by_name() {
  local want="$1" id name rest
  while IFS=, read -r id name rest; do
    if [ "$name" = "$want" ]; then
      printf '%s' "$id"
      return 0
    fi
  done
  return 0
}

# kcadm exits non-zero on an empty result, which `set -o pipefail` would turn
# into a script abort. Swallow that and let the caller test for an empty string.
kc_get() {
  $KCADM "$@" 2>/dev/null || true
}

$KCADM config credentials --server http://localhost:8080 --realm master \
  --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASSWORD"

# ── realm ───────────────────────────────────────────────────────────────────
# A realm of its own on this dev-shared Keycloak. `master` stays the admin realm
# and is never used by an application.
if $KCADM get "realms/$REALM" >/dev/null 2>&1; then
  echo "realm $REALM: exists"
else
  echo "realm $REALM: creating"
  $KCADM create realms -s "realm=$REALM" -s enabled=true \
    -s "displayName=$REALM_DISPLAY_NAME" \
    -s registrationAllowed=false \
    -s resetPasswordAllowed=false
fi

# ── `groups` client scope + Group Membership mapper ──────────────────────────
# Without this the id_token carries no `groups` claim and Nextcloud cannot tell
# a modeler from a viewer.
SCOPE_ID=$(kc_get get client-scopes -r "$REALM" --fields id,name --format csv --noquotes | csv_id_by_name groups)
if [ -z "$SCOPE_ID" ]; then
  echo "client scope groups: creating"
  SCOPE_ID=$($KCADM create client-scopes -r "$REALM" -i \
    -s name=groups -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true' \
    -s 'attributes."display.on.consent.screen"=false')
  $KCADM create "client-scopes/$SCOPE_ID/protocol-mappers/models" -r "$REALM" \
    -s name=groups -s protocol=openid-connect \
    -s protocolMapper=oidc-group-membership-mapper \
    -s 'config."claim.name"=groups' \
    -s 'config."full.path"=false' \
    -s 'config."id.token.claim"=true' \
    -s 'config."access.token.claim"=true' \
    -s 'config."userinfo.token.claim"=true'
else
  echo "client scope groups: exists ($SCOPE_ID)"
fi

# ── client ──────────────────────────────────────────────────────────────────
CID=$(kc_get get clients -r "$REALM" -q "clientId=$CLIENT_ID" --fields id,clientId --format csv --noquotes | csv_id_by_name "$CLIENT_ID")
CLIENT_ARGS=(
  -s "clientId=$CLIENT_ID"
  -s "name=Nextcloud"
  -s enabled=true
  -s protocol=openid-connect
  -s publicClient=false
  -s standardFlowEnabled=true
  -s implicitFlowEnabled=false
  -s directAccessGrantsEnabled=false
  -s serviceAccountsEnabled=false
  -s "secret=$CLIENT_SECRET"
  -s "redirectUris=[\"$NEXTCLOUD_URL/apps/user_oidc/code\",\"$NEXTCLOUD_URL/index.php/apps/user_oidc/code\"]"
  -s "webOrigins=[\"$NEXTCLOUD_URL\"]"
  -s "attributes={\"post.logout.redirect.uris\":\"$NEXTCLOUD_URL/*\"}"
)
if [ -z "$CID" ]; then
  echo "client $CLIENT_ID: creating"
  CID=$($KCADM create clients -r "$REALM" -i "${CLIENT_ARGS[@]}")
else
  echo "client $CLIENT_ID: updating ($CID)"
  $KCADM update "clients/$CID" -r "$REALM" "${CLIENT_ARGS[@]}"
fi
$KCADM update "clients/$CID/default-client-scopes/$SCOPE_ID" -r "$REALM" 2>/dev/null \
  || echo "WARN: could not attach the groups scope to the client - do it in the console (Client > Client scopes > Add > groups, Default)"

# ── groups ──────────────────────────────────────────────────────────────────
for g in "$WRITE_GROUP" "$READ_GROUP"; do
  if [ -n "$(kc_get get groups -r "$REALM" -q "search=$g" --fields id,name --format csv --noquotes | csv_id_by_name "$g")" ]; then
    echo "group $g: exists"
  else
    echo "group $g: creating"
    $KCADM create groups -r "$REALM" -s "name=$g"
  fi
done

# Every GitHub user who logs in lands in the read-only group; write access is an
# explicit, manual promotion to $WRITE_GROUP.
READ_GID=$(kc_get get groups -r "$REALM" -q "search=$READ_GROUP" --fields id,name --format csv --noquotes | csv_id_by_name "$READ_GROUP")
if [ -n "$READ_GID" ]; then
  $KCADM update "realms/$REALM/default-groups/$READ_GID" -r "$REALM" -b '{}' 2>/dev/null \
    || echo "WARN: could not set $READ_GROUP as a realm default group - do it in the console (Realm settings > User registration > Default groups)"
fi

# ── GitHub identity provider ────────────────────────────────────────────────
IDP_ARGS=(
  -s alias=github
  -s providerId=github
  -s enabled=true
  -s trustEmail=true
  -s storeToken=false
  -s addReadTokenRoleOnCreate=false
  -s linkOnly=false
  -s "config.clientId=$GITHUB_CLIENT_ID"
  -s "config.clientSecret=$GITHUB_CLIENT_SECRET"
  -s "config.defaultScope=read:user user:email"
  -s "config.syncMode=IMPORT"
)
if $KCADM get identity-provider/instances/github -r "$REALM" >/dev/null 2>&1; then
  echo "idp github: updating"
  $KCADM update identity-provider/instances/github -r "$REALM" "${IDP_ARGS[@]}"
else
  echo "idp github: creating"
  $KCADM create identity-provider/instances -r "$REALM" "${IDP_ARGS[@]}"
fi

echo "done"
REMOTE

cat <<EOF

════════════════════════════════════════════════════════════════════════════════
Keycloak is configured.

  Realm            ${REALM}
  Discovery URI    ${KC_PUBLIC_URL}/realms/${REALM}/.well-known/openid-configuration
  Client id        ${CLIENT_ID}
  Client secret    ${CLIENT_SECRET}

Register this callback URL on the GitHub OAuth App:

  ${KC_PUBLIC_URL}/realms/${REALM}/broker/github/endpoint

Then create the Nextcloud secret:

  kubectl --context=${KUBE_CONTEXT} -n ${KC_NAMESPACE} create secret generic nextcloud-oidc \\
    --from-literal=client-id='${CLIENT_ID}' \\
    --from-literal=client-secret='${CLIENT_SECRET}' \\
    --from-literal=discovery-uri='${KC_PUBLIC_URL}/realms/${REALM}/.well-known/openid-configuration'

To grant write access to someone, add their user to the ${WRITE_GROUP} group:

  ${KC_PUBLIC_URL}/admin/master/console/#/${REALM}/groups
════════════════════════════════════════════════════════════════════════════════
EOF
