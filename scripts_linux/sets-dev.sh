#!/bin/bash
# Gere les ensembles de services du cluster local (argocd/dev/root/sets/<ensemble>.yaml).
#   sets-dev.sh list
#   sets-dev.sh add <ensemble>...
#   sets-dev.sh remove <ensemble>...   (jamais `core`)
cd "$(dirname "$0")/.."

ALL_SETS="core server server-idle gameplay voice admin observability"

check_set() {
    case " $ALL_SETS " in
        *" $1 "*) ;;
        *) echo "Ensemble inconnu : $1 (existants : $ALL_SETS)" >&2; exit 2 ;;
    esac
}

cmd="$1"; shift
case "$cmd" in
    list)
        for set in $ALL_SETS; do
            if kubectl get application "root-$set" -n argocd >/dev/null 2>&1; then
                echo "$set: deploye"
            else
                echo "$set: absent"
            fi
        done
        ;;
    add)
        [ $# -gt 0 ] || { echo "Usage: $0 add <ensemble>..." >&2; exit 2; }
        for set in "$@"; do
            check_set "$set"
            # server / server-idle define the same Application: drop the other root first (its
            # children are kept, the new root adopts them and updates the Application).
            case "$set" in
                server) kubectl delete application root-server-idle -n argocd --ignore-not-found ;;
                server-idle) kubectl delete application root-server -n argocd --ignore-not-found ;;
            esac
            kubectl apply -f "argocd/dev/root/sets/$set.yaml"
        done
        ;;
    remove)
        [ $# -gt 0 ] || { echo "Usage: $0 remove <ensemble>..." >&2; exit 2; }
        for set in "$@"; do
            check_set "$set"
            [ "$set" = "core" ] && { echo "core ne peut pas etre retire." >&2; exit 2; }
            # La racine d'abord (sinon son selfHeal recree les Applications), puis chaque
            # Application avec le finalizer ArgoCD pour que ses ressources soient supprimees.
            kubectl delete application "root-$set" -n argocd --ignore-not-found
            # Les dossiers de l'ensemble sont lus dans sa racine (argocd/dev/root/sets/<set>.yaml).
            for dir in $(sed -n 's/^ *path: //p' "argocd/dev/root/sets/$set.yaml"); do
              for f in "$dir"/*.yaml; do
                app=$(sed -n 's/^  name: //p' "$f" | head -1)
                kubectl patch application "$app" -n argocd --type=merge \
                    -p '{"metadata":{"finalizers":["resources-finalizer.argocd.argoproj.io"]}}' >/dev/null 2>&1
                kubectl delete application "$app" -n argocd --wait=false --ignore-not-found
              done
            done
        done
        ;;
    *)
        echo "Usage: $0 list | add <ensemble>... | remove <ensemble>..." >&2
        exit 2
        ;;
esac
