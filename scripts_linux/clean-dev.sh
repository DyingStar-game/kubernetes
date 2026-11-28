#!/bin/bash

# Le script vit dans scripts_linux/ : on se replace a la racine du depot.
cd "$(dirname "$0")/.."

K3D_CLUSTER="${K3D_CLUSTER:-dyingstar}"

echo "--- Complete k3d cleanup (cluster $K3D_CLUSTER) ---"

# 0. Host-side leftovers: Telepresence session
if command -v telepresence > /dev/null 2>&1; then
    echo "Disconnecting Telepresence..."
    telepresence quit -s > /dev/null 2>&1
fi

# 0b. Remove the /etc/hosts entries added by start-dev.sh (needs sudo; skipped if not possible)
if [ -f hosts_config.txt ]; then
    while IFS= read -r domain || [ -n "$domain" ]; do
        [[ -z "$domain" || "$domain" =~ ^# ]] && continue
        sudo -n sed -i "/$domain/d" /etc/hosts 2>/dev/null || echo "   (skip /etc/hosts: $domain)"
    done < hosts_config.txt
fi

# 1. Delete the cluster (nodes, load balancer, network and volumes go with it)
k3d cluster delete "$K3D_CLUSTER"

echo "Cleanup finished. You can now restart the startup script."
