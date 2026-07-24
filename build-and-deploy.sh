#!/bin/bash
set -e

CONFIG_FILE="dev-projects.yaml"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Erreur : Le fichier de configuration '$CONFIG_FILE' est introuvable."
  exit 1
fi

TARGET_ARG=${1:-all}

echo "🔌 Connexion au daemon Docker de Minikube..."
eval $(minikube -p minikube docker-env)

# Fonction de build et déploiement
build_and_deploy() {
  local name=$1
  local proj_dir=$2
  local dockerfile=$3
  local deployment=$4
  local namespace=$5
  local tag=$6

  echo "=================================================="
  echo "🚀 Traitement de : $name"
  echo "=================================================="

  if [ ! -d "$proj_dir" ]; then
    echo "❌ Erreur : Le répertoire '$proj_dir' n'existe pas."
    return 1
  fi

  echo "📦 Build de l'image $deployment:$tag..."
  docker build -t "$deployment:$tag" -f "$proj_dir/$dockerfile" "$proj_dir"

  echo "🔄 Patch du déploiement $deployment..."
  kubectl patch deployment "$deployment" -n "$namespace" --type='json' -p="[
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/imagePullPolicy\", \"value\": \"Never\"},
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/image\", \"value\": \"$deployment:$tag\"}
  ]"
  
  echo "✅ Terminé pour $name !"
  echo ""
}

# Utilisation de Python (dispo partout) pour parser proprement le YAML sans dépendance externe
FOUND=$(python3 -c "
import yaml, sys

with open('$CONFIG_FILE', 'r') as f:
    data = yaml.safe_load(f)

ns = data.get('namespace', 'default')
tag = data.get('tag', 'dev')
target = '$TARGET_ARG'
found_any = False

for p in data.get('projects', []):
    name = p['name']
    if target == 'all' or target == name:
        print(f\"{name}|{p['path']}|{p['dockerfile']}|{p['deployment']}|{ns}|{tag}\")
        found_any = True

if not found_any and target != 'all':
    sys.exit(2)
" || exit 2)

# Si le projet demandé n'existe pas
if [ $? -eq 2 ]; then
  echo "❌ Cible '$TARGET_ARG' introuvable dans '$CONFIG_FILE'."
  exit 1
fi

# Boucle sur les projets retournés par le parser Python
while IFS='|' read -r name proj_dir dockerfile deployment namespace tag; do
  [ -z "$name" ] && continue
  build_and_deploy "$name" "$proj_dir" "$dockerfile" "$deployment" "$namespace" "$tag"
done <<< "$FOUND"

echo "🎉 Opération terminée avec succès !"