param(
    # S'arreter une fois le cluster et ArgoCD en place, sans toucher au fichier hosts. Rien ne demande alors les droits administrateur.
    # Pour qui joint le cluster autrement (relais, port-forward) ou veut seulement l'installer.
    [switch]$NoTunnel,

    # Ensembles de services a deployer (voir argocd\dev\root\sets\). `core` est toujours deploye.
    # Defaut : tous sauf observability (lourde, ~1,5 Go : a ajouter a la demande via sets-dev.ps1 add observability
    # ou -Sets ...,observability). Ex. level designer : -Sets core
    [string[]]$Sets = @('server', 'gameplay', 'voice', 'admin')
)

$ALL_SETS = @('core', 'server', 'server-idle', 'gameplay', 'voice', 'admin', 'observability')
$Sets = @('core') + @($Sets | ForEach-Object { $_ -split ',' } | Where-Object { $_ }) | Select-Object -Unique
# Un ensemble serveur exactement : server (image Godot) ou server-idle (pod a vide, Telepresence).
if (($Sets -contains 'server') -and ($Sets -contains 'server-idle')) { Write-Error 'server et server-idle sont exclusifs.'; exit 2 }
if (($Sets -notcontains 'server') -and ($Sets -notcontains 'server-idle')) { $Sets += 'server' }
foreach ($set in $Sets) {
    if ($ALL_SETS -notcontains $set) {
        Write-Error "Ensemble inconnu : $set (existants : $($ALL_SETS -join ', '))"
        exit 2
    }
}

# Le fichier hosts exige les droits administrateur ; le reste, non.
# (Avant, `#Requires -RunAsAdministrator` les imposait a tout le script.)
if (-not $NoTunnel) {
    $principal = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Error ("start-dev.ps1 doit etre lance dans une console administrateur " +
            "(fichier hosts). Sans toucher au fichier hosts : start-dev.ps1 -NoTunnel")
        exit 1
    }
}

# Les chemins ci-dessous sont relatifs a la racine du depot, alors que le
# script vit dans scripts_windows\ : on se replace donc a la racine.
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

# Configuration
$DOMAINS_FILE = "hosts_config.txt"
$TRAEFIK_NS = "traefik"
$ROOT_APP_NAME = "root-dev"
$ROOT_APP_NS = "argocd"
# Cluster local : k3d (k3s dans Docker Desktop / WSL2). Nom modifiable : $env:K3D_CLUSTER.
$K3D_CLUSTER = if ($env:K3D_CLUSTER) { $env:K3D_CLUSTER } else { "dyingstar" }

# 0. Déconnecter Telepresence avant de démarrer le cluster
# Lorsqu'il est connecté, Telepresence enregistre un domaine de recherche DNS
# "tel2-search" sur la machine hôte. Docker recopie la liste de recherche de
# l'hôte dans les conteneurs des noeuds k3d à leur création, puis kubelet
# (dnsPolicy: ClusterFirst) l'ajoute à chaque pod. Avec ndots:5, les résolutions
# internes au cluster comme traffic-manager.telepresence.svc.cluster.local sont
# d'abord étendues en "<nom>.tel2-search", résolues par le résolveur de l'hôte
# vers la mauvaise IP, et le traffic-agent injecté ne devient jamais prêt ->
# "telepresence intercept" échoue avec "context deadline exceeded".
if (Get-Command telepresence -ErrorAction SilentlyContinue) {
    Write-Host "--- Déconnexion de Telepresence (évite de polluer le DNS du cluster) ---"
    telepresence quit -s 2>$null | Out-Null
}

# 1. Démarrer le cluster k3d
Write-Host "--- Démarrage du cluster (k3d : $K3D_CLUSTER) ---"
# Voir start-dev.sh : Traefik est deploye par ArgoCD (on desactive celui de k3s) ; les ports
# 80/443/8443 et 30101 (UDP, horizon) sont publies sur localhost, donc ni tunnel ni IP de noeud.
# La taille du cluster est celle de Docker Desktop (Settings > Resources).
# Le depot est monte sous /mnt/local-repo.git ; le chemin Windows (C:\x) est converti en /c/x
# car le « : » de la lettre de lecteur gene la syntaxe --volume.
$repoPath = $pwd.Path -replace '\\', '/'
if ($repoPath -match '^([A-Za-z]):(.*)$') { $repoPath = '/' + $Matches[1].ToLower() + $Matches[2] }
k3d cluster list $K3D_CLUSTER 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    k3d cluster start $K3D_CLUSTER
} else {
    k3d cluster create $K3D_CLUSTER `
        --agents 0 --wait `
        --volume "${repoPath}:/mnt/local-repo.git@all" `
        -p "80:80@loadbalancer" -p "443:443@loadbalancer" `
        -p "8443:8443@loadbalancer" -p "30101:30101/udp@loadbalancer" `
        --k3s-arg "--disable=traefik@server:*"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Creation du cluster k3d impossible (ports 80/443/8443/30101 deja pris ? voir : docker ps)."
        exit 1
    }
}
kubectl config use-context "k3d-$K3D_CLUSTER"
# Les values dev reclament la StorageClass "standard" ; k3s fournit "local-path" : alias.
@'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
'@ | kubectl apply -f - | Out-Null

# Garde-fou : sans API joignable, tout ce qui suit echoue en cascade.
kubectl get --raw /version --request-timeout=20s 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "L'API Kubernetes (k3d) est injoignable (contexte : $(kubectl config current-context 2>$null))."
    exit 1
}

# 1b. Relever les limites inotify (voir start-dev.sh, etape 1b) : sans cela horizon plante avec
# "too many open files" (fsnotify). Les noeuds k3d sont des conteneurs privilegies : `docker exec`
# le fait tout de suite (un pod aurait du telecharger une image dans un cluster vide : ~90 s).
Write-Host "--- Relevage des limites inotify ---"
docker ps --format '{{.Names}}' --filter "name=^k3d-$K3D_CLUSTER-(server|agent)-" | ForEach-Object {
    docker exec $_ sh -c 'sysctl -w fs.inotify.max_user_watches=1048576 && sysctl -w fs.inotify.max_user_instances=8192' | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "limites inotify non relevees sur $_ (horizon peut echouer avec 'too many open files')" }
}

# 2. Installation initiale (si absente)
$helmList = helm list -n argocd 2>$null
if (-not ($helmList -match "argocd")) {
    Write-Host "--- Installation d'ArgoCD et des composants ---"

    kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml
    helm repo add argo https://argoproj.github.io/argo-helm
    helm repo update

    helm install argocd argo/argo-cd `
        --namespace argocd `
        --create-namespace `
        -f argocd/values.yaml `
        -f argocd/values-dev.yaml

    kubectl apply -f argocd/root-dev.yaml
} else {
    Write-Host "--- ArgoCD déjà installé, installation ignorée ---"
}

# 3. Vérifier le statut de la Root App et synchroniser si nécessaire
Write-Host "--- Vérification du statut de l'application Root ---"

# Attendre que le CRD Application soit disponible
kubectl wait --for=condition=Established crd/applications.argoproj.io --timeout=60s | Out-Null

Write-Host "Attente du déploiement d'ArgoCD..."

# Attendre argocd-server
kubectl wait --namespace argocd --for=condition=Available deployment/argocd-server --timeout=300s

# Attendre argocd-repo-server
kubectl wait --namespace argocd --for=condition=Available deployment/argocd-repo-server --timeout=300s

Write-Host "ArgoCD est prêt !"

# Récupérer le statut de synchronisation
$SYNC_STATUS = kubectl get application $ROOT_APP_NAME -n $ROOT_APP_NS -o jsonpath='{.status.sync.status}' 2>$null

if ($SYNC_STATUS -ne "Synced") {
    Write-Host "--- Root App est '$SYNC_STATUS'. Déclenchement de la synchronisation via l'API... ---"

    kubectl annotate application $ROOT_APP_NAME -n $ROOT_APP_NS argocd.argoproj.io/refresh=hard --overwrite
    kubectl patch app $ROOT_APP_NAME -n $ROOT_APP_NS --type=merge -p '
    spec:
      syncPolicy:
        automated:
          selfHeal: true
          prune: true
   '

    Write-Host "--- Synchronisation déclenchée. En attente que les ressources soient saines... ---"
    kubectl wait --for=jsonpath='{.status.sync.status}=Synced' `
        application/$ROOT_APP_NAME -n $ROOT_APP_NS --timeout=120s
} else {
    Write-Host "--- Root App déjà synchronisée ---"
}

# 3b. Deployer les ensembles demandes (root-dev ne porte que les AppProjects).
# Un ensemble absent de la liste n'est PAS retire d'un cluster qui tourne deja :
# voir scripts_windows\sets-dev.ps1 remove <ensemble>.
Write-Host "--- Deploiement des ensembles : $($Sets -join ', ') ---"
# `core` d'abord, puis les autres une fois sain : les autres ensembles (services de jeu, voix...)
# ont besoin de Keycloak et des bases, et tout demarrer d'un coup les fait boucler en erreur.
# L'attente est au mieux : sur une machine lente, un avertissement, puis on applique quand meme.
# Le serveur de jeu part avec core : horizon l'attend, core ne serait jamais sain sans lui.
$first = @('core', 'server', 'server-idle')
foreach ($set in ($first | Where-Object { $Sets -contains $_ })) { kubectl apply -f "argocd/dev/root/sets/$set.yaml" }
$others = @($Sets | Where-Object { $first -notcontains $_ })
if ($others.Count -gt 0) {
    Write-Host "--- Attente de l'ensemble core (10 min max) ---"
    kubectl wait --for=jsonpath='{.status.health.status}=Healthy' application/root-core -n argocd --timeout=600s
    if ($LASTEXITCODE -ne 0) { Write-Warning "core n'est pas encore sain, on applique les autres ensembles quand meme" }
    foreach ($set in $others) { kubectl apply -f "argocd/dev/root/sets/$set.yaml" }
}

if ($NoTunnel) {
    Write-Host "--- -NoTunnel : fichier hosts non modifie ---"
    Write-Host "--- Cluster et ArgoCD prets. ---"
    exit 0
}

# 4. Attendre que le service Traefik ait une adresse
Write-Host "--- Attente de l'IP de Traefik ---"
$IP = ""
while ([string]::IsNullOrEmpty($IP)) {
    Start-Sleep -Seconds 2
    $IP = kubectl get svc traefik -n $TRAEFIK_NS `
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
}
Write-Host "IP Traefik détectée : $IP"
# Le LoadBalancer porte une IP de noeud Docker, mais l'acces hote passe par les ports publies.
$IP = "127.0.0.1"

# 5. Mettre à jour le fichier hosts
$HOSTS_FILE = "C:\Windows\System32\drivers\etc\hosts"

function Read-HostsFile {
    param($Path, $MaxRetries = 5, $DelayMs = 300)
    for ($i = 0; $i -lt $MaxRetries; $i++) {
        try {
            $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $reader = New-Object System.IO.StreamReader($stream)
            $content = $reader.ReadToEnd()
            $reader.Close()
            $stream.Close()
            return $content -split "`r`n|`n"
        }
        catch {
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    throw "Impossible de lire $Path après $MaxRetries tentatives."
}

function Write-HostsFile {
    param($Path, $Lines, $MaxRetries = 8, $DelayMs = 400)
    for ($i = 0; $i -lt $MaxRetries; $i++) {
        try {
            $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
            $writer = New-Object System.IO.StreamWriter($stream)
            foreach ($line in $Lines) { $writer.WriteLine($line) }
            $writer.Flush()
            $writer.Close()
            $stream.Close()
            return $true
        }
        catch {
            Write-Host "    (tentative $($i+1)/$MaxRetries échouée, nouvelle tentative...)"
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    return $false
}

if (Test-Path $DOMAINS_FILE) {
    Write-Host "--- Mise à jour de $HOSTS_FILE ---"
    $domains = Get-Content $DOMAINS_FILE | Where-Object {
        $_ -notmatch '^\s*$' -and $_ -notmatch '^\s*#'
    }

    $hostsLines = if (Test-Path $HOSTS_FILE) { Read-HostsFile -Path $HOSTS_FILE } else { @() }
    $hostsContent = [System.Collections.Generic.List[string]]$hostsLines

    foreach ($domain in $domains) {
        $hostsContent = [System.Collections.Generic.List[string]]($hostsContent | Where-Object { $_ -notmatch [regex]::Escape($domain) })
        $hostsContent.Add("$IP $domain")
        Write-Host "    -> $domain configuré en mémoire"
    }

    if (Write-HostsFile -Path $HOSTS_FILE -Lines $hostsContent) {
        Write-Host "--- Fichier hosts enregistré avec succès ! ---"
    } else {
        Write-Error "Impossible d'écrire dans le fichier hosts après plusieurs tentatives."
    }
}

Write-Host "--- Environnement prêt ! ---"