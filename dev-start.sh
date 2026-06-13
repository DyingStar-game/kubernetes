#!/bin/bash

# Configuration
DOMAINS_FILE="hosts_config.txt"
TRAEFIK_NS="traefik"
ROOT_APP_NAME="root-app" # Ensure this matches your app name in ArgoCD
ROOT_APP_NS="argocd"

# 1. Start Minikube
echo "--- Starting Minikube ---"
minikube start --disk-size=150g

# 2. Mount local directory (background)
echo "--- Mounting local directory ---"
minikube mount "$PWD":/mnt/local-repo.git > /dev/null 2>&1 &

# 3. Initial installation (if not present)
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
    
    kubectl apply -f argocd/root-app-dev.yaml
else
    echo "--- ArgoCD already installed, skipping installation ---"
fi

# 4. Check Root App status and Sync if necessary
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

# 5. Launch tunnel
echo "--- Launching tunnel ---"
# Note: minikube tunnel requires sudo
sudo -E minikube tunnel > /dev/null 2>&1 &

# 6. Get Traefik IP
echo "--- Retrieving Traefik IP ---"
IP=""
while [ -z "$IP" ]; do
  sleep 2
  IP=$(kubectl get svc traefik -n $TRAEFIK_NS -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
done
echo "Traefik IP detected: $IP"

# 7. Wait for Traefik IP
echo "--- Waiting for Traefik IP ---"
IP=""
while [ -z "$IP" ]; do
  sleep 2
  IP=$(kubectl get svc traefik -n $TRAEFIK_NS -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
done
echo "Traefik IP detected: $IP"

# 8. Update /etc/hosts
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