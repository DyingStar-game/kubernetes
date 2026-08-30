#!/bin/bash
#
# build-and-deploy.sh — Build une image DyingStar depuis les sources locales et
#                       la déploie dans la stack minikube/ArgoCD.
#
# Les cibles sont décrites dans dev-projects.yaml. Une cible vise soit le container
# principal d'un Deployment, soit un de ses init containers (champ `initContainer`,
# ex. les images horizon-plugins / horizon-data recopiées dans un emptyDir partagé).
#
# ArgoCD gère le dev avec selfHeal: true. Pour que le patch ne soit pas annulé au
# reconcile suivant, chaque Application dev correspondante déclare un bloc
# `ignoreDifferences` sur l'image et l'imagePullPolicy (argocd/dev/game/*.yaml).
#
# Usage :
#   ./scripts_linux/build-and-deploy.sh                 # menu interactif
#   ./scripts_linux/build-and-deploy.sh horizon-data    # une cible précise
#   ./scripts_linux/build-and-deploy.sh all             # toutes les cibles

set -e

cd "$(dirname "$0")/.."

CONFIG_FILE="dev-projects.yaml"
EXPECTED_CONTEXT="minikube"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Erreur : Le fichier de configuration '$CONFIG_FILE' est introuvable."
  exit 1
fi

usage() {
  echo "Usage : $0 [cible|all]"
  echo ""
  echo "Cibles disponibles dans '$CONFIG_FILE' :"
  list_targets | while IFS='|' read -r name deployment init; do
    if [ -n "$init" ]; then
      echo "  $name  (init container '$init' du deployment '$deployment')"
    else
      echo "  $name  (deployment '$deployment')"
    fi
  done
  echo "  all  (toutes les cibles)"
}

# Parse le YAML avec Python (pas de dépendance externe type yq).
# Sortie : une ligne par projet retenu, champs séparés par '|' :
#   name|path|dockerfile|deployment|image|initContainer|namespace|tag
# Code de sortie 2 si la cible demandée n'existe pas.
parse_projects() {
  local target=$1
  python3 - "$CONFIG_FILE" "$target" <<'PY_EOF'
import sys, yaml

config_file, target = sys.argv[1], sys.argv[2]

with open(config_file, 'r') as f:
    data = yaml.safe_load(f)

ns = data.get('namespace', 'default')
tag = data.get('tag', 'dev')
found_any = False

for p in data.get('projects', []):
    name = p['name']
    if target == 'all' or target == name:
        image = p.get('image', name)
        init = p.get('initContainer', '')
        print('|'.join([name, p['path'], p['dockerfile'], p['deployment'],
                        image, init, ns, tag]))
        found_any = True

if not found_any:
    sys.exit(2)
PY_EOF
}

# Liste courte pour le menu et l'usage : name|deployment|initContainer
list_targets() {
  parse_projects all | while IFS='|' read -r name path dockerfile deployment image init ns tag; do
    echo "$name|$deployment|$init"
  done
}

# Build et déploiement d'une cible.
build_and_deploy() {
  local name=$1 proj_dir=$2 dockerfile=$3 deployment=$4
  local image=$5 init_container=$6 namespace=$7 tag=$8

  echo "=================================================="
  echo "🚀 Traitement de : $name"
  echo "=================================================="

  if [ ! -d "$proj_dir" ]; then
    echo "❌ Erreur : Le répertoire '$proj_dir' n'existe pas."
    return 1
  fi
  if [ ! -f "$proj_dir/$dockerfile" ]; then
    echo "❌ Erreur : Le Dockerfile '$proj_dir/$dockerfile' n'existe pas."
    return 1
  fi

  echo "📦 Build de l'image $image:$tag..."
  docker build -t "$image:$tag" -f "$proj_dir/$dockerfile" "$proj_dir"

  # Cible du patch : un init container nommé, ou le container principal.
  # On utilise un strategic merge patch : `name` est la merge key de containers
  # et initContainers, donc pas d'index à calculer (celui des init containers de
  # horizon dépend du nombre d'entrées `dependsOn` dans les values).
  local list_key container_name deploy_json
  deploy_json=$(kubectl get deployment "$deployment" -n "$namespace" -o json 2>/dev/null || true)
  if [ -z "$deploy_json" ]; then
    echo "❌ Erreur : Deployment '$deployment' introuvable dans le namespace '$namespace'."
    echo "   La stack est-elle démarrée ? Lancez ./scripts_linux/start-dev.sh"
    return 1
  fi

  if [ -n "$init_container" ]; then
    list_key="initContainers"
    container_name="$init_container"
    if ! echo "$deploy_json" | grep -q "\"name\": \"$init_container\""; then
      echo "❌ Erreur : init container '$init_container' absent du deployment '$deployment'."
      echo "   Vérifiez que l'image correspondante est activée dans les values (ex. dataImage.enabled)."
      return 1
    fi
  else
    list_key="containers"
    container_name=$(echo "$deploy_json" | python3 -c \
      'import json,sys; print(json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0]["name"])')
  fi

  local gen_before gen_after
  gen_before=$(echo "$deploy_json" | python3 -c \
    'import json,sys; print(json.load(sys.stdin)["metadata"]["generation"])')

  echo "🔄 Patch de $deployment ($list_key/$container_name)..."
  kubectl patch deployment "$deployment" -n "$namespace" -p "{
    \"spec\": {\"template\": {\"spec\": {\"$list_key\": [{
      \"name\": \"$container_name\",
      \"image\": \"$image:$tag\",
      \"imagePullPolicy\": \"Never\"
    }]}}}
  }"

  gen_after=$(kubectl get deployment "$deployment" -n "$namespace" \
    -o jsonpath='{.metadata.generation}')

  # Le tag est stable (:dev). Quand seul le *contenu* de l'image change, le pod
  # template reste identique : le patch est un no-op, aucun rollout n'est
  # déclenché et le pod continue de tourner sur l'ancienne image. Dans ce cas il
  # faut forcer le redémarrage — mais uniquement dans ce cas, sinon un patch qui
  # change réellement l'image provoquerait deux rollouts d'affilée.
  if [ "$gen_before" = "$gen_after" ]; then
    echo "♻️  Pod template inchangé (tag stable) — redémarrage forcé du pod..."
    kubectl rollout restart "deployment/$deployment" -n "$namespace"
  fi

  echo "⏳ Attente du rollout..."
  kubectl rollout status "deployment/$deployment" -n "$namespace" --timeout=300s

  echo "✅ Terminé pour $name !"
  echo ""
}

# --- 1. Détermination de la cible --------------------------------------------
if [ $# -gt 0 ]; then
  TARGET_ARG=$1
elif [ -t 0 ]; then
  echo "Aucune cible fournie — que voulez-vous rebuilder ?"
  echo ""
  MENU_ENTRIES=()
  MENU_NAMES=()
  while IFS='|' read -r name deployment init; do
    MENU_NAMES+=("$name")
    if [ -n "$init" ]; then
      MENU_ENTRIES+=("$name  →  init container '$init' de '$deployment'")
    else
      MENU_ENTRIES+=("$name  →  deployment '$deployment'")
    fi
  done < <(list_targets)
  MENU_NAMES+=("all")
  MENU_ENTRIES+=("all  →  toutes les cibles")

  PS3=$'\n'"Votre choix (numéro, Ctrl-C pour annuler) : "
  select choice in "${MENU_ENTRIES[@]}"; do
    if [ -n "$choice" ]; then
      TARGET_ARG=${MENU_NAMES[$((REPLY - 1))]}
      break
    fi
    echo "Choix invalide."
  done
  if [ -z "${TARGET_ARG:-}" ]; then
    echo ""
    echo "Annulé — aucune cible sélectionnée."
    exit 1
  fi
  echo ""
else
  echo "❌ Erreur : aucune cible fournie et pas de terminal interactif."
  echo ""
  usage
  exit 1
fi

# --- 2. Récupération des projets à traiter -----------------------------------
set +e
FOUND=$(parse_projects "$TARGET_ARG")
PARSE_RC=$?
set -e

if [ $PARSE_RC -eq 2 ]; then
  echo "❌ Cible '$TARGET_ARG' introuvable dans '$CONFIG_FILE'."
  echo ""
  usage
  exit 1
elif [ $PARSE_RC -ne 0 ]; then
  echo "❌ Erreur lors de la lecture de '$CONFIG_FILE'."
  exit 1
fi

# --- 3. Garde-fou : uniquement le cluster minikube local ---------------------
# Le script force imagePullPolicy: Never — l'exécuter sur preprod/prod casserait
# les déploiements (aucune image locale sur ces nœuds).
CURRENT_CONTEXT=$(kubectl config current-context 2>/dev/null || true)
if [ "$CURRENT_CONTEXT" != "$EXPECTED_CONTEXT" ]; then
  echo "❌ Erreur : le contexte kube courant est '${CURRENT_CONTEXT:-<aucun>}', attendu '$EXPECTED_CONTEXT'."
  echo "   Lancez : kubectl config use-context $EXPECTED_CONTEXT"
  exit 1
fi

# --- 4. Build dans le daemon Docker de minikube ------------------------------
echo "🔌 Connexion au daemon Docker de Minikube..."
eval "$(minikube -p minikube docker-env)"
# Requis : .docker/Dockerfile.plugins utilise --mount=type=cache et le Dockerfile
# de resourcesDynamic déclare une directive « # syntax= ».
export DOCKER_BUILDKIT=1

while IFS='|' read -r name proj_dir dockerfile deployment image init namespace tag; do
  [ -z "$name" ] && continue
  build_and_deploy "$name" "$proj_dir" "$dockerfile" "$deployment" \
                   "$image" "$init" "$namespace" "$tag"
done <<< "$FOUND"

echo "🎉 Opération terminée avec succès !"
