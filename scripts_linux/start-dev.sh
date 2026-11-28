#!/bin/bash

# Les chemins ci-dessous sont relatifs a la racine du depot, alors que le script
# vit dans scripts_linux/ : on se replace donc a la racine.
cd "$(dirname "$0")/.."

# --no-tunnel : s'arreter une fois le cluster et ArgoCD en place, sans lancer
# toucher a /etc/hosts. Rien ne demande alors sudo. Pour qui
# joint le cluster autrement (relais, port-forward) ou veut seulement l'installer.
NO_TUNNEL=0
# --sets a,b : ensembles de services a deployer (voir argocd/dev/root/sets/). `core` est
# toujours deploye. Defaut : tous. Ex. level designer : --sets core
ALL_SETS="core server server-idle gameplay voice admin observability"
# server / server-idle sont exclusifs (meme Application godotserver) : le defaut prend `server`.
SETS="core server gameplay voice admin observability"
while [ $# -gt 0 ]; do
    case "$1" in
        --no-tunnel) NO_TUNNEL=1 ;;
        --sets) shift; SETS="core ${1//,/ }" ;;
        --sets=*) SETS="core ${1#--sets=}"; SETS="${SETS//,/ }" ;;
        *) echo "Option inconnue : $1 (options : --no-tunnel, --sets a,b)" >&2; exit 2 ;;
    esac
    shift
done
# Alias : `telepresence` (nom employe par le panel) = `server-idle` (pod a vide pour Telepresence).
SETS=" $SETS "
case "$SETS" in
    *" server-idle "*) SETS="${SETS// telepresence / }" ;;
    *) SETS="${SETS// telepresence / server-idle }" ;;
esac
SETS=$(echo $SETS)
# Un ensemble serveur exactement : `server` (image Godot) ou `server-idle` (pod a vide, Telepresence).
# Aucun des deux : `server`. Les deux : erreur.
case " $SETS " in
    *" server "*" server-idle "*|*" server-idle "*" server "*)
        echo "server et server-idle sont exclusifs." >&2; exit 2 ;;
    *" server "*|*" server-idle "*) ;;
    *) SETS="$SETS server" ;;
esac
for set in $SETS; do
    case " $ALL_SETS " in
        *" $set "*) ;;
        *) echo "Ensemble inconnu : $set (existants : $ALL_SETS)" >&2; exit 2 ;;
    esac
done

# Chronometrage : chaque phase affiche le temps ecoule depuis le lancement.
T0=$(date +%s)
tick() { echo "--- [$(( $(date +%s) - T0 ))s] $* ---"; }

# Cluster local : k3d (k3s dans Docker). Nom modifiable : K3D_CLUSTER.
K3D_CLUSTER="${K3D_CLUSTER:-dyingstar}"

# Configuration
DOMAINS_FILE="hosts_config.txt"
TRAEFIK_NS="traefik"
ROOT_APP_NAME="root-dev" # Ensure this matches your app name in ArgoCD
ROOT_APP_NS="argocd"

# 0. Disconnect Telepresence before starting the cluster
# While connected, Telepresence registers a "tel2-search" DNS search domain on
# the host. Docker copies the host search list into the k3d node containers when
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

# 1. Start the k3d cluster
echo "--- Starting cluster (k3d: $K3D_CLUSTER) ---"
# k3d (k3s dans Docker) : demarrage ~15 s, pas de VM. Traefik est deploye par ArgoCD
# (argocd/dev/infra/core/traefik-app.yaml) : on desactive celui embarque par k3s.
# Les ports 80/443/8443 (telepresence) et 30101 (horizon, UDP/QUIC) sont publies sur
# localhost : ni tunnel ni sudo, /etc/hosts pointe sur 127.0.0.1.
# Le depot est monte dans chaque noeud sur /mnt/local-repo.git : la source ArgoCD
# file:///mnt/local-repo.git y est lue telle quelle (aucun push, aucun serveur git).
# La taille du cluster est celle de Docker (Docker Desktop : Settings > Resources).
if k3d cluster list "$K3D_CLUSTER" > /dev/null 2>&1; then
    k3d cluster start "$K3D_CLUSTER" || true
else
    k3d cluster create "$K3D_CLUSTER" \
        --agents 0 --wait \
        --volume "$PWD:/mnt/local-repo.git@all" \
        -p "80:80@loadbalancer" -p "443:443@loadbalancer" \
        -p "8443:8443@loadbalancer" -p "30101:30101/udp@loadbalancer" \
        --k3s-arg "--disable=traefik@server:*" \
        || { echo "ERREUR : creation du cluster k3d impossible (port 80/443/8443/30101 deja pris ? voir : docker ps)." >&2; exit 1; }
fi
kubectl config use-context "k3d-$K3D_CLUSTER"
tick "cluster k3d pret"
# Les values dev reclament la StorageClass "standard" ; k3s fournit "local-path" :
# on cree un alias pointant sur le meme provisioner.
kubectl apply -f - <<'EOF' > /dev/null
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
EOF

# Garde-fou : sans API joignable, tout ce qui suit echoue en cascade (helm, kubectl, attente
# infinie de Traefik). On s'arrete ici avec un message clair.
if ! kubectl get --raw /version --request-timeout=20s > /dev/null 2>&1; then
    echo "ERREUR : l'API Kubernetes (k3d) est injoignable (contexte : $(kubectl config current-context 2>/dev/null))." >&2
    exit 1
fi

# 1b. Raise inotify limits inside the node. The default limits
# (fs.inotify.max_user_watches=65536/8192, max_user_instances=128) are far too
# low once several dozen pods mount ConfigMaps/Secrets (each mount consumes
# watches) — horizon then panics with "to create fsnotify watcher: too many
# open files" and exits (139). Applied at runtime via a privileged pod + nsenter
# (nodes are privileged k3d containers); /etc/sysctl.d is inside
# the node's writable overlay and survives pod restarts, but a `k3d cluster
# delete` / node recreate needs this step again — hence right after start.
echo "--- Raising inotify limits inside the node ---"
# Les sysctl inotify sont ceux du noyau hote / de la VM Docker.
kubectl apply -f - <<'EOF' >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: inotify-fix
  namespace: kube-system
spec:
  hostPID: true
  restartPolicy: Never
  tolerations:
    - operator: Exists
  containers:
    - name: fix
      image: busybox:1.37
      securityContext:
        privileged: true
      command: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "--", "sh", "-c"]
      args:
        - |
          sysctl -w fs.inotify.max_user_watches=1048576
          sysctl -w fs.inotify.max_user_instances=8192
          printf 'fs.inotify.max_user_watches=1048576\nfs.inotify.max_user_instances=8192\n' > /etc/sysctl.d/99-inotify.conf
EOF
kubectl -n kube-system wait --for=jsonpath='{.status.phase}=Succeeded' pod/inotify-fix --timeout=90s
kubectl -n kube-system logs inotify-fix
kubectl -n kube-system delete pod inotify-fix --wait=false >/dev/null

tick "limites inotify relevees"

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

tick "ArgoCD installe"

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

# 3b. Deployer les ensembles demandes (root-dev ne porte que les AppProjects).
# Un ensemble absent de la liste n'est PAS retire d'un cluster qui tourne deja :
# voir scripts_linux/sets-dev.sh remove <ensemble>.
echo "--- Deploying sets: $(echo $SETS | tr ' ' '\n' | awk '!seen[$0]++' | tr '\n' ' ') ---"
# `core` first, then the others once it is healthy: the other sets (game services, voice...) need
# Keycloak and the databases, and starting everything at once makes them crash-loop until those are
# up. Inside `core`, the sync-wave annotations of its Applications order the rest (see the README).
# The wait is best-effort: a slow machine only gets a warning, the other sets are applied anyway.
# Le serveur de jeu part avec core : horizon l'attend, core ne serait jamais sain sans lui.
for set in core server server-idle; do
    case " $SETS " in *" $set "*) kubectl apply -f "argocd/dev/root/sets/$set.yaml" ;; esac
done
OTHERS=$(echo $SETS | tr ' ' '\n' | awk '!seen[$0]++ && $0 != "core" && $0 != "server" && $0 != "server-idle"')
if [ -n "$OTHERS" ]; then
    echo "--- Waiting for the core set to be healthy (up to 10 min) ---"
    kubectl wait --for=jsonpath='{.status.health.status}=Healthy' application/root-core -n argocd --timeout=600s \
        || echo "WARNING: core is not healthy yet, applying the other sets anyway"
    tick "ensemble core sain (ou delai depasse)"
    for set in $OTHERS; do
        kubectl apply -f "argocd/dev/root/sets/$set.yaml"
    done
fi

if [ "$NO_TUNNEL" = "1" ]; then
    echo "--- --no-tunnel : ni tunnel ni /etc/hosts ---"
    echo "--- Cluster and ArgoCD ready. ---"
    exit 0
fi

# 4. Wait for the Traefik service to get an address
echo "--- Waiting for Traefik IP ---"
IP=""
while [ -z "$IP" ]; do
  sleep 2
  IP=$(kubectl get svc traefik -n $TRAEFIK_NS -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
done
echo "Traefik IP detected: $IP"
# Le LoadBalancer porte une IP de noeud Docker, mais l'acces hote passe par les
# ports publies sur localhost.
IP=127.0.0.1

# 5. Update /etc/hosts
if [ -f "$DOMAINS_FILE" ]; then
    echo "--- Updating /etc/hosts ---"
    while IFS= read -r domain || [ -n "$domain" ]; do
        [[ -z "$domain" || "$domain" =~ ^# ]] && continue
        sudo sed -i "/$domain/d" /etc/hosts
        echo "$IP $domain" | sudo tee -a /etc/hosts > /dev/null
        echo "   -> $domain configured"
    done < "$DOMAINS_FILE"
fi

tick "environnement pret"
echo "--- Environment ready! ---"