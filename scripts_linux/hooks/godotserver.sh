#!/bin/bash
#
# hooks/godotserver.sh — Reproduit en local les traitements que la CI applique aux
# sources du serveur Godot avant le docker build (DyingStar/.github/workflows/
# build-server-preprod.yaml), puis restaure les fichiers touchés.
#
# Appelé par build-and-deploy.sh, cwd = racine du dépôt DyingStar :
#   godotserver.sh prepare   avant `docker build`
#   godotserver.sh cleanup   après (toujours, même en cas d'échec / Ctrl-C)
#
# $HOOK_STATE_DIR (fourni par l'appelant) sert à sauvegarder les fichiers modifiés :
# on ne passe pas par `git checkout` pour ne pas écraser des modifications locales
# non commitées dans ces fichiers.
#
# Variables :
#   GODOT_STREAM_CHANNEL   valeur de [stream] channel dans server.ini
#                          (défaut : dev — la CI preprod met "preprod")
#
# Étapes de la CI et leur équivalent ici :
#   - rm -fr assets_blender          → rien à faire : déjà exclu par .dockerignore
#   - sed channel dans server.ini    → prepare (GODOT_STREAM_CHANNEL)
#   - dev tools OFF dans globals.gd  → prepare, avec la même vérification que la CI
#   - docker build --no-cache        → NO_CACHE=1 côté build-and-deploy.sh

set -e

MODE=${1:?usage: $0 prepare|cleanup}
: "${HOOK_STATE_DIR:?HOOK_STATE_DIR doit être défini par build-and-deploy.sh}"

STREAM_CHANNEL=${GODOT_STREAM_CHANNEL:-dev}
DEV_TOOLS=(spawn_wheel zapette toggle_eva build_chunk_skirts)

# Fichiers modifiés par prepare — sauvegardés tels quels dans $HOOK_STATE_DIR.
FILES=(server.ini scenes/globals/globals.gd)

prepare() {
  for f in "${FILES[@]}"; do
    if [ ! -f "$f" ]; then
      echo "❌ hook godotserver : fichier '$f' introuvable dans $PWD."
      exit 1
    fi
    mkdir -p "$HOOK_STATE_DIR/$(dirname "$f")"
    cp -p "$f" "$HOOK_STATE_DIR/$f"
  done

  echo "   • server.ini : [stream] channel = \"$STREAM_CHANNEL\""
  sed -i -E "s|^(channel = )\"[^\"]*\"|\1\"$STREAM_CHANNEL\"|" server.ini
  grep -qE "^channel = \"$STREAM_CHANNEL\"" server.ini \
    || { echo "❌ hook godotserver : channel non appliqué dans server.ini"; exit 1; }

  # Globals.ENABLED_DEV_TOOLS est livré ON dans le dépôt pour les devs ; un build
  # ne doit pas les embarquer. Chaque clé est vérifiée après le sed : une clé
  # renommée ou supprimée fait échouer le build plutôt que d'embarquer l'outil.
  echo "   • globals.gd : dev tools OFF (${DEV_TOOLS[*]})"
  for tool in "${DEV_TOOLS[@]}"; do
    sed -i -E "s/^([[:space:]]+\"$tool\": )true,/\1false,/" scenes/globals/globals.gd
    grep -qE "^[[:space:]]+\"$tool\": false," scenes/globals/globals.gd \
      || { echo "❌ hook godotserver : dev tool '$tool' non désactivé dans globals.gd"; exit 1; }
  done
}

cleanup() {
  for f in "${FILES[@]}"; do
    if [ -f "$HOOK_STATE_DIR/$f" ]; then
      cp -p "$HOOK_STATE_DIR/$f" "$f"
      echo "   • $f restauré"
    fi
  done
}

case "$MODE" in
  prepare) prepare ;;
  cleanup) cleanup ;;
  *) echo "usage: $0 prepare|cleanup"; exit 1 ;;
esac
