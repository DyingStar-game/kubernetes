#!/usr/bin/env bash
#
# dev.sh — Local development launcher for StarDeception
#
# Reads dev-local.conf to decide which services to build locally vs pull
# from Harbor. Services listed (uncommented) in dev-local.conf use the
# pre-built "develop" image from Harbor; all others are built from source.
#
# Usage:
#   ./dev.sh                          # Deploy all services
#   ./dev.sh horizon                  # Deploy only horizon
#   ./dev.sh godotserver horizon      # Deploy only godotserver + horizon
#   ./dev.sh --tail=false             # Extra args passed to skaffold
#   ./dev.sh horizon --tail=false     # Single service + extra args

set -euo pipefail
cd "$(dirname "$0")"

# Safety: dev.sh must only ever target the local minikube cluster. Refuse to
# run if the active kube-context is anything else (e.g. the prod 'dyingstar'
# context), to avoid building/deploying dev images on a real cluster.
EXPECTED_CONTEXT="minikube"
CURRENT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
if [[ "$CURRENT_CONTEXT" != "$EXPECTED_CONTEXT" ]]; then
  echo "ERROR: current kube-context is '${CURRENT_CONTEXT:-<none>}', expected '${EXPECTED_CONTEXT}'." >&2
  echo "       Run: kubectl config use-context ${EXPECTED_CONTEXT}" >&2
  exit 1
fi

ALL_SERVICES=(keycloak service-resourcesdynamic godotserver horizon)
CONF_FILE="dev-local.conf"

# Parse harbor services from config file
declare -A HARBOR_SERVICES
if [[ -f "$CONF_FILE" ]]; then
  while IFS= read -r line; do
    # Strip whitespace and skip empty lines / comments
    line="${line%%#*}"
    line="$(echo "$line" | xargs 2>/dev/null || true)"
    [[ -z "$line" ]] && continue
    HARBOR_SERVICES["$line"]=1
  done < "$CONF_FILE"
fi

# Separate service names from extra skaffold args
REQUESTED_SERVICES=()
EXTRA_ARGS=()
for arg in "$@"; do
  is_service=false
  for svc in "${ALL_SERVICES[@]}"; do
    if [[ "$arg" == "$svc" ]]; then
      is_service=true
      break
    fi
  done
  if $is_service; then
    REQUESTED_SERVICES+=("$arg")
  else
    EXTRA_ARGS+=("$arg")
  fi
done

# If no services specified, deploy all
if [[ ${#REQUESTED_SERVICES[@]} -eq 0 ]]; then
  REQUESTED_SERVICES=("${ALL_SERVICES[@]}")
fi

# Build module list
MODULES=()
for svc in "${REQUESTED_SERVICES[@]}"; do
  if [[ -n "${HARBOR_SERVICES[$svc]+x}" ]]; then
    MODULES+=("${svc}-harbor")
    echo "  ${svc}: using Harbor image (develop)"
  else
    MODULES+=("$svc")
    echo "  ${svc}: building locally"
  fi
done

MODULE_ARG=$(IFS=,; echo "${MODULES[*]}")
echo ""
echo "Running: skaffold dev -m ${MODULE_ARG} ${EXTRA_ARGS[*]:-}"
echo ""
exec skaffold dev -m "$MODULE_ARG" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
