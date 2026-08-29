#!/bin/bash

# Les chemins ci-dessous sont relatifs a la racine du depot, alors que le script
# vit dans scripts_linux/ : on se replace donc a la racine.
cd "$(dirname "$0")/.."

# Configuration
DOMAINS_FILE="hosts_config.txt"
TRAEFIK_NS="traefik"
ROOT_APP_NAME="root-dev" # Ensure this matches your app name in ArgoCD
ROOT_APP_NS="argocd"

# 0. Disconnect Telepresence before starting Minikube
# While connected, Telepresence registers a "tel2-search" DNS search domain on
# the host. Docker copies the host search list into the Minikube container when
# it is created, and kubelet (dnsPolicy: ClusterFirst) then appends it to every
# pod. With ndots:5, in-cluster lookups such as
# traffic-manager.telepresence.svc.cluster.local are expanded to
# "<name>.tel2-search" first, resolved by the host resolver to the wrong IP, and
# the injected traffic-agent never becomes ready -> "telepresence intercept"
# fails with "context deadline exceeded".
if command -v telepresence > /dev/null 2>&1; then
    echo "--- Disconnecting Telepresence (avoids polluting cluster DNS) ---"
    telepresence quit -s > /dev/null 2>&1
fi

# 1. Start Minikube
echo "--- Starting Minikube ---"
minikube start --disk-size=150g --mount-string $PWD:/mnt/local-repo.git

# 2. Initial installation (if not present)
if ! helm list -n argocd | grep -q "argocd"; then
    echo "--- Installing ArgoCD and components ---"
    
    kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml
    helm repo add argo https://argoproj.github.io/argo-helm
    helm repo update
    
    helm install argocd argo/argo-cd \
      --namespace argocd \
      --create-namespace \
      -f argocd/values.yaml \
      -f argocd/values-dev.yaml 
    
    kubectl apply -f argocd/root-dev.yaml
else
    echo "--- ArgoCD already installed, skipping installation ---"
fi

# 3. Check Root App status and Sync if necessary
echo "--- Checking Root Application status ---"

# Wait for the Application CRD to be available
kubectl wait --for=condition=Established crd/applications.argoproj.io --timeout=60s > /dev/null 2>&1

# Get the current sync status
SYNC_STATUS=$(kubectl get application $ROOT_APP_NAME -n $ROOT_APP_NS -o jsonpath='{.status.sync.status}' 2>/dev/null)

if [ "$SYNC_STATUS" != "Synced" ]; then
    echo "--- Root App is $SYNC_STATUS. Triggering sync via API... ---"
    
    # Use kubectl to patch the app status to trigger a sync (equivalent to 'argocd app sync')
    kubectl annotate application $ROOT_APP_NAME -n $ROOT_APP_NS argocd.argoproj.io/refresh=hard --overwrite
    kubectl patch app $ROOT_APP_NAME -n $ROOT_APP_NS -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":true,"prune":true}}}}' --type=merge
    
    echo "--- Sync triggered. Waiting for resources to become healthy... ---"
    kubectl wait --for=jsonpath='{.status.sync.status}=Synced' application/$ROOT_APP_NAME -n $ROOT_APP_NS --timeout=120s
else
    echo "--- Root App is already Synced ---"
fi

# 4. Launch tunnel
echo "--- Launching tunnel ---"
# Note: minikube tunnel requires sudo
sudo HOME=$HOME minikube tunnel > /dev/null 2>&1 &

# 5. Get Traefik IP
echo "--- Retrieving Traefik IP ---"
IP=""
while [ -z "$IP" ]; do
  sleep 2
  IP=$(kubectl get svc traefik -n $TRAEFIK_NS -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
done
echo "Traefik IP detected: $IP"

# 6. Wait for Traefik IP
echo "--- Waiting for Traefik IP ---"
IP=""
while [ -z "$IP" ]; do
  sleep 2
  IP=$(kubectl get svc traefik -n $TRAEFIK_NS -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
done
echo "Traefik IP detected: $IP"

# 7. Update /etc/hosts
if [ -f "$DOMAINS_FILE" ]; then
    echo "--- Updating /etc/hosts ---"
    while IFS= read -r domain || [ -n "$domain" ]; do
        [[ -z "$domain" || "$domain" =~ ^# ]] && continue
        sudo sed -i "/$domain/d" /etc/hosts
        echo "$IP $domain" | sudo tee -a /etc/hosts > /dev/null
        echo "   -> $domain configured"
    done < "$DOMAINS_FILE"
fi

echo "--- Environment ready! ---"