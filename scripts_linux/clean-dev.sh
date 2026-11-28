#!/bin/bash
# =============================================================
#  clean-dev.sh — Nettoie TOUT l'environnement dev local
# =============================================================
#  - cluster k3d (noeuds, load balancer, reseau, volumes) et ses restes Docker
#  - restes d'un ancien minikube (cluster, conteneur, reseau, volume) s'il y en a
#  - contextes / clusters / users kube correspondants dans le kubeconfig
#  - entrees /etc/hosts ajoutees par start-dev.sh
#  - session Telepresence et relais expose-horizon encore actifs
#
#  Option : --prune  supprime aussi le cache de build Docker et les images orphelines
#                    (dangling) ; ne touche pas aux images nommees ni aux autres projets.
#  Variable : K3D_CLUSTER (defaut : dyingstar).

# Le script vit dans scripts_linux/ : on se replace a la racine du depot.
cd "$(dirname "$0")/.."

K3D_CLUSTER="${K3D_CLUSTER:-dyingstar}"
PRUNE=0
for arg in "$@"; do
    case "$arg" in
        --prune) PRUNE=1 ;;
        -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Option inconnue : $arg (option : --prune)" >&2; exit 2 ;;
    esac
done

have() { command -v "$1" > /dev/null 2>&1; }

echo "--- Nettoyage complet de l'environnement dev (cluster $K3D_CLUSTER) ---"

# 0. Processus de l'hote : Telepresence, relais expose-horizon
if have telepresence; then
    echo "Deconnexion de Telepresence..."
    telepresence quit -s > /dev/null 2>&1
fi
pkill -f "expose-horizon" 2>/dev/null

# 0b. Entrees /etc/hosts ajoutees par start-dev.sh (sudo requis ; ignore sinon)
if [ -f hosts_config.txt ]; then
    while IFS= read -r domain || [ -n "$domain" ]; do
        [[ -z "$domain" || "$domain" =~ ^# ]] && continue
        sudo -n sed -i "/$domain/d" /etc/hosts 2>/dev/null || echo "   (hosts ignore : $domain)"
    done < hosts_config.txt
fi

# 1. Cluster k3d (le nom courant, puis tout cluster k3d-<nom> du depot si besoin)
if have k3d; then
    k3d cluster delete "$K3D_CLUSTER" 2>/dev/null || echo "   (cluster $K3D_CLUSTER absent)"
fi

# 2. Restes Docker de k3d (cluster supprime a moitie : noeuds, load balancer, outils, reseau, volumes)
if have docker; then
    for c in $(docker ps -aq --filter "name=^k3d-${K3D_CLUSTER}-" 2>/dev/null); do
        docker rm -f "$c" > /dev/null 2>&1 && echo "   conteneur k3d supprime : $c"
    done
    docker network rm "k3d-${K3D_CLUSTER}" > /dev/null 2>&1 && echo "   reseau k3d-${K3D_CLUSTER} supprime"
    for v in "k3d-${K3D_CLUSTER}-images"; do
        docker volume rm "$v" > /dev/null 2>&1 && echo "   volume $v supprime"
    done
fi

# 3. Ancien minikube (heritage) : cluster, conteneur, reseau, volume, processus, montages
if have minikube; then
    echo "Ancien minikube detecte : suppression..."
    minikube delete --all > /dev/null 2>&1
fi
if have docker; then
    docker rm -f minikube > /dev/null 2>&1 && echo "   conteneur minikube supprime"
    docker network rm minikube > /dev/null 2>&1 && echo "   reseau minikube supprime"
    docker volume rm minikube > /dev/null 2>&1 && echo "   volume minikube supprime"
    # Relais de l'ancien chemin reseau du devpanel
    for r in traefik-http-relay traefik-https-relay horizon-wt-relay; do
        docker rm -f "$r" > /dev/null 2>&1 && echo "   relais $r supprime"
    done
fi
pkill -f "minikube tunnel" 2>/dev/null
pkill -f "minikube mount" 2>/dev/null
if mount | grep -q "minikube"; then
    echo "Demontage des montages minikube residuels..."
    mount | grep "minikube" | awk '{print $3}' | xargs -r sudo umount -l
fi

# 4. kubeconfig : contextes, clusters et users du dev local (jamais ceux d'un autre cluster)
if have kubectl; then
    for name in "k3d-${K3D_CLUSTER}" minikube; do
        kubectl config delete-context "$name" > /dev/null 2>&1 && echo "   contexte kube $name supprime"
        kubectl config delete-cluster "$name" > /dev/null 2>&1
        kubectl config unset "users.$name" > /dev/null 2>&1
        kubectl config unset "users.admin@$name" > /dev/null 2>&1
    done
fi

# 5. Option : cache de build et images orphelines (rien d'autre)
if [ "$PRUNE" = "1" ] && have docker; then
    echo "Nettoyage du cache de build Docker et des images orphelines..."
    docker builder prune -f > /dev/null 2>&1
    docker image prune -f > /dev/null 2>&1
fi

echo "Nettoyage termine. Vous pouvez relancer start-dev.sh."
