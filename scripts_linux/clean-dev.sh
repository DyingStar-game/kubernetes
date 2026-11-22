#!/bin/bash

# Le script vit dans scripts_linux/ : on se replace a la racine du depot.
cd "$(dirname "$0")/.."

echo "--- Complete Minikube cleanup ---"

# 0. Host-side leftovers: Telepresence session, tunnel, port-forwards
if command -v telepresence > /dev/null 2>&1; then
    echo "Disconnecting Telepresence..."
    telepresence quit -s > /dev/null 2>&1
fi
sudo -n pkill -f "minikube tunnel" 2>/dev/null || pkill -f "minikube tunnel" 2>/dev/null

# 0b. Remove the /etc/hosts entries added by start-dev.sh (needs sudo; skipped if not possible)
if [ -f hosts_config.txt ]; then
    while IFS= read -r domain || [ -n "$domain" ]; do
        [[ -z "$domain" || "$domain" =~ ^# ]] && continue
        sudo -n sed -i "/$domain/d" /etc/hosts 2>/dev/null || echo "   (skip /etc/hosts: $domain)"
    done < hosts_config.txt
fi

# 1. Stop and delete the cluster
minikube delete --all

# 2. Kill all remaining Minikube processes
echo "Stopping persistent processes..."
pkill -9 -f minikube
pkill -9 -f "minikube mount"

# 3. Clean up mounts (sometimes necessary if mount points are locked)
# This command finds Minikube mount points and unmounts them
if mount | grep -q "minikube"; then
    echo "Unmounting residual mount points..."
    mount | grep "minikube" | awk '{print $3}' | xargs -r sudo umount -l
fi

# 4. Remove configuration files to start fresh
# Warning: This deletes your local Minikube configs; use with caution
echo "Removing ~/.minikube/cache directory (optional)..."
# rm -rf ~/.minikube/cache 

echo "Cleanup finished. You can now restart the startup script."