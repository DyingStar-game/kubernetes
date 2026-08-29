#!/bin/bash

# Les chemins ci-dessous sont relatifs a la racine du depot, alors que le script
# vit dans scripts_linux/ : on se replace donc a la racine.
cd "$(dirname "$0")/.."

# =============================================================
#  check-dev.sh — Vérification des prérequis pour start-dev.sh
# =============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

ok()   { echo -e "  ${GREEN}[OK]${NC}    $1"; }
fail() { echo -e "  ${RED}[FAIL]${NC}  $1"; ((ERRORS++)); }
warn() { echo -e "  ${YELLOW}[WARN]${NC}  $1"; ((WARNINGS++)); }
info() { echo -e "  ${CYAN}[INFO]${NC}  $1"; }

section() { echo -e "\n${CYAN}▶ $1${NC}"; }

version_gte() {
    # Returns 0 (true) if $1 >= $2 (semver)
    [ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

echo ""
echo "======================================================"
echo "  Vérification des prérequis — environnement dev K8s  "
echo "======================================================"

# ----------------------------------------------------------
# 1. Outils requis
# ----------------------------------------------------------
section "Outils requis"

check_tool() {
    local CMD=$1
    local MIN_VER=$2
    local GET_VER=$3  # commande pour extraire la version

    if ! command -v "$CMD" &>/dev/null; then
        fail "$CMD : non trouvé (requis)"
        return
    fi

    local VER
    VER=$(eval "$GET_VER" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

    if [ -z "$VER" ]; then
        warn "$CMD : trouvé mais version non détectable"
        return
    fi

    if version_gte "$VER" "$MIN_VER"; then
        ok "$CMD $VER (min: $MIN_VER)"
    else
        fail "$CMD $VER — version trop ancienne (min: $MIN_VER)"
    fi
}

check_tool "kubectl"  "1.25.0"  "kubectl version --client --short 2>/dev/null || kubectl version --client"
check_tool "minikube" "1.30.0"  "minikube version"
check_tool "helm"     "3.10.0"  "helm version --short"
check_tool "docker"   "20.10.0" "docker --version"
check_tool "git"      "2.30.0"  "git --version"

# sudo (facultatif mais requis pour tunnel + hosts)
if command -v sudo &>/dev/null; then
    ok "sudo : disponible"
else
    warn "sudo : non trouvé — requis pour minikube tunnel et /etc/hosts"
fi

# ----------------------------------------------------------
# 2. Ressources système
# ----------------------------------------------------------
section "Ressources système"

# RAM (min 4 Go recommandé, 8 Go idéal)
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
if [ -n "$TOTAL_RAM_KB" ]; then
    TOTAL_RAM_GB=$(( TOTAL_RAM_KB / 1024 / 1024 ))
    if [ "$TOTAL_RAM_GB" -ge 8 ]; then
        ok "RAM : ${TOTAL_RAM_GB} Go"
    elif [ "$TOTAL_RAM_GB" -ge 4 ]; then
        warn "RAM : ${TOTAL_RAM_GB} Go — 8 Go recommandés pour Minikube + ArgoCD"
    else
        fail "RAM : ${TOTAL_RAM_GB} Go — minimum 4 Go requis"
    fi
else
    warn "RAM : impossible à lire (/proc/meminfo indisponible)"
fi

# CPU (min 2 cœurs)
CPU_CORES=$(nproc 2>/dev/null)
if [ -n "$CPU_CORES" ]; then
    if [ "$CPU_CORES" -ge 4 ]; then
        ok "CPU : $CPU_CORES cœurs"
    elif [ "$CPU_CORES" -ge 2 ]; then
        warn "CPU : $CPU_CORES cœurs — 4 cœurs recommandés"
    else
        fail "CPU : $CPU_CORES cœur — minimum 2 requis"
    fi
else
    warn "CPU : nombre de cœurs non détectable"
fi

# Espace disque (min 20 Go libres sur /)
FREE_DISK_GB=$(df -BG / 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}')
if [ -n "$FREE_DISK_GB" ]; then
    if [ "$FREE_DISK_GB" -ge 20 ]; then
        ok "Disque libre : ${FREE_DISK_GB} Go"
    elif [ "$FREE_DISK_GB" -ge 10 ]; then
        warn "Disque libre : ${FREE_DISK_GB} Go — 20 Go recommandés (--disk-size=150g dans start-dev.sh)"
    else
        fail "Disque libre : ${FREE_DISK_GB} Go — minimum 20 Go requis"
    fi
else
    warn "Disque : espace libre non détectable"
fi

# ----------------------------------------------------------
# 3. Docker daemon
# ----------------------------------------------------------
section "Docker daemon"

if docker info &>/dev/null; then
    ok "Docker daemon : en cours d'exécution"
else
    fail "Docker daemon : non démarré ou permission refusée"
    info "Lancez 'sudo systemctl start docker' ou ajoutez votre user au groupe docker"
fi

# ----------------------------------------------------------
# 4. Virtualisation
# ----------------------------------------------------------
section "Virtualisation"

if grep -qE 'vmx|svm' /proc/cpuinfo 2>/dev/null; then
    ok "Virtualisation matérielle : activée (vmx/svm)"
else
    warn "Virtualisation matérielle : non détectée — Minikube utilisera le driver docker"
fi

# ----------------------------------------------------------
# 5. Connectivité réseau
# ----------------------------------------------------------
section "Connectivité réseau"

check_url() {
    local URL=$1
    local LABEL=$2
    if curl -sf --max-time 5 "$URL" -o /dev/null 2>/dev/null; then
        ok "$LABEL"
    else
        fail "$LABEL — injoignable (vérifiez le proxy/firewall)"
    fi
}

check_url "https://registry.k8s.io"                                          "registry.k8s.io (images Kubernetes)"
check_url "https://harbor.dyingstar-game.space"                              "Harbor"
check_url "https://argoproj.github.io"                                       "ArgoCD Helm repo"
check_url "https://github.com/kubernetes-sigs/gateway-api/releases"          "GitHub (Gateway API)"

# ----------------------------------------------------------
# 6. Fichiers de configuration locaux
# ----------------------------------------------------------
section "Fichiers de configuration locaux"

check_file() {
    local FILE=$1
    if [ -f "$FILE" ]; then
        ok "$FILE : présent"
    else
        fail "$FILE : manquant"
    fi
}

check_file "argocd/values.yaml"
check_file "argocd/values-dev.yaml"
check_file "argocd/root-dev.yaml"

if [ -f "hosts_config.txt" ]; then
    ok "hosts_config.txt : présent"
    DOMAIN_COUNT=$(grep -cE '^[^#[:space:]]' hosts_config.txt 2>/dev/null || echo 0)
    info "$DOMAIN_COUNT domaine(s) configuré(s)"
else
    warn "hosts_config.txt : absent — aucune entrée /etc/hosts ne sera créée"
fi

# ----------------------------------------------------------
# Bilan
# ----------------------------------------------------------
echo ""
echo "======================================================"
if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
    echo -e "  ${GREEN}Tout est prêt — vous pouvez lancer ./scripts_linux/start-dev.sh${NC}"
elif [ "$ERRORS" -eq 0 ]; then
    echo -e "  ${YELLOW}$WARNINGS avertissement(s) — ./scripts_linux/start-dev.sh devrait fonctionner${NC}"
else
    echo -e "  ${RED}$ERRORS erreur(s) bloquante(s), $WARNINGS avertissement(s)${NC}"
    echo -e "  ${RED}Corrigez les erreurs avant de lancer ./scripts_linux/start-dev.sh${NC}"
fi
echo "======================================================"
echo ""

exit "$ERRORS"