#!/usr/bin/env bash
#
# Creates the two secrets that harbor/values-preprod.yaml references, by
# copying the values out of the CURRENTLY RUNNING Harbor install.
#
# Why this exists: the Harbor chart generates several secret values with
# randAlphaNum / htpasswd / genCA and only falls back to a `lookup` of the
# live secret. Argo CD renders with `helm template` (no cluster access), so
# `lookup` returns empty and those values would be regenerated on every sync.
# Pinning them to pre-existing secrets makes Argo's renders deterministic.
#
# Run this ONCE, BEFORE letting Argo sync the harbor Application. It is
# idempotent and never overwrites an existing secret.
#
# Requires: an existing Harbor install (the chart-managed harbor-core,
# harbor-registry, harbor-jobservice and harbor-registry-htpasswd secrets).
#
# Usage: ./bootstrap-secrets.sh [kube-context]

set -euo pipefail

NS=harbor
CTX="${1:-}"
KUBECTL=(kubectl)
[ -n "$CTX" ] && KUBECTL+=(--context "$CTX")
KUBECTL+=(-n "$NS")

get() { # get <secret> <key>
  "${KUBECTL[@]}" get secret "$1" -o "jsonpath={.data.$2}" | base64 -d
}

exists() { "${KUBECTL[@]}" get secret "$1" >/dev/null 2>&1; }

for s in harbor-core harbor-registry harbor-jobservice harbor-registry-htpasswd; do
  exists "$s" || { echo "ERROR: source secret '$s' not found in ns/$NS." >&2
                   echo "This script adopts an existing install; it cannot bootstrap a new one." >&2
                   exit 1; }
done

if exists harbor-bootstrap; then
  echo "harbor-bootstrap already exists — leaving it untouched."
else
  echo "Creating harbor-bootstrap ..."
  "${KUBECTL[@]}" create secret generic harbor-bootstrap \
    --from-literal=secretKey="$(get harbor-core secretKey)" \
    --from-literal=HARBOR_ADMIN_PASSWORD="$(get harbor-core HARBOR_ADMIN_PASSWORD)" \
    --from-literal=secret="$(get harbor-core secret)" \
    --from-literal=CSRF_KEY="$(get harbor-core CSRF_KEY)" \
    --from-literal=REGISTRY_PASSWD="$(get harbor-core REGISTRY_CREDENTIAL_PASSWORD)" \
    --from-literal=REGISTRY_HTTP_SECRET="$(get harbor-registry REGISTRY_HTTP_SECRET)" \
    --from-literal=JOBSERVICE_SECRET="$(get harbor-jobservice JOBSERVICE_SECRET)" \
    --from-literal=REGISTRY_HTPASSWD="$(get harbor-registry-htpasswd REGISTRY_HTPASSWD)"
fi

if exists harbor-token-ca; then
  echo "harbor-token-ca already exists — leaving it untouched."
else
  echo "Creating harbor-token-ca ..."
  # Token-signing CA. Regenerating this invalidates every issued registry
  # token, so it is copied rather than re-created.
  "${KUBECTL[@]}" create secret generic harbor-token-ca \
    --from-literal=tls.crt="$(get harbor-core tls.crt)" \
    --from-literal=tls.key="$(get harbor-core tls.key)"
fi

echo
echo "Done. Verify with:"
echo "  kubectl -n $NS get secret harbor-bootstrap harbor-token-ca"
