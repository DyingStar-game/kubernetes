#Requires -RunAsAdministrator

# Les chemins ci-dessous sont relatifs a la racine du depot, alors que le
# script vit dans scripts_windows\ : on se replace donc a la racine.
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

# Configuration
$DOMAINS_FILE = "hosts_config.txt"
$TRAEFIK_NS = "traefik"
$ROOT_APP_NAME = "root-dev"
$ROOT_APP_NS = "argocd"

# 0. Déconnecter Telepresence avant de démarrer Minikube
# Lorsqu'il est connecté, Telepresence enregistre un domaine de recherche DNS
# "tel2-search" sur la machine hôte. Docker recopie la liste de recherche de
# l'hôte dans le conteneur Minikube à sa création, puis kubelet
# (dnsPolicy: ClusterFirst) l'ajoute à chaque pod. Avec ndots:5, les résolutions
# internes au cluster comme traffic-manager.telepresence.svc.cluster.local sont
# d'abord étendues en "<nom>.tel2-search", résolues par le résolveur de l'hôte
# vers la mauvaise IP, et le traffic-agent injecté ne devient jamais prêt ->
# "telepresence intercept" échoue avec "context deadline exceeded".
if (Get-Command telepresence -ErrorAction SilentlyContinue) {
    Write-Host "--- Déconnexion de Telepresence (évite de polluer le DNS du cluster) ---"
    telepresence quit -s 2>$null | Out-Null
}

# 1. Démarrer Minikube
Write-Host "--- Démarrage de Minikube ---"
minikube start --disk-size=150g --mount-string "${pwd}:/mnt/local-repo.git"

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

# 4. Lancer le tunnel
Write-Host "--- Lancement du tunnel ---"
# Note : minikube tunnel nécessite des droits administrateur (déjà requis en haut du script)
$tunnelJob = Start-Job -ScriptBlock {
    minikube tunnel
}

# 5. Récupérer l'IP de Traefik
Write-Host "--- Récupération de l'IP de Traefik ---"
$IP = ""
while ([string]::IsNullOrEmpty($IP)) {
    Start-Sleep -Seconds 2
    $IP = kubectl get svc traefik -n $TRAEFIK_NS `
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
}
Write-Host "IP Traefik détectée : $IP"

# 6. Mettre à jour le fichier hosts
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