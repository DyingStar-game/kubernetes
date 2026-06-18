#Requires -RunAsAdministrator

# Configuration
$DOMAINS_FILE = "hosts_config.txt"
$TRAEFIK_NS = "traefik"
$ROOT_APP_NAME = "root-app"
$ROOT_APP_NS = "argocd"

# 1. Démarrer Minikube
Write-Host "--- Démarrage de Minikube ---"
minikube start --disk-size=150g

# 2. Monter le répertoire local (en arrière-plan)
Write-Host "--- Montage du répertoire local ---"
$mountJob = Start-Job -ScriptBlock {
    param($pwd)
    minikube mount "${pwd}:/mnt/local-repo.git"
} -ArgumentList $PWD

# 3. Installation initiale (si absente)
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

    kubectl apply -f argocd/root-app-dev.yaml
} else {
    Write-Host "--- ArgoCD déjà installé, installation ignorée ---"
}

# 4. Vérifier le statut de la Root App et synchroniser si nécessaire
Write-Host "--- Vérification du statut de l'application Root ---"

# Attendre que le CRD Application soit disponible
kubectl wait --for=condition=Established crd/applications.argoproj.io --timeout=60s | Out-Null

# Récupérer le statut de synchronisation
$SYNC_STATUS = kubectl get application $ROOT_APP_NAME -n $ROOT_APP_NS -o jsonpath='{.status.sync.status}' 2>$null

if ($SYNC_STATUS -ne "Synced") {
    Write-Host "--- Root App est '$SYNC_STATUS'. Déclenchement de la synchronisation via l'API... ---"

    kubectl annotate application $ROOT_APP_NAME -n $ROOT_APP_NS argocd.argoproj.io/refresh=hard --overwrite
    kubectl patch app $ROOT_APP_NAME -n $ROOT_APP_NS `
        -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":true,"prune":true}}}}' `
        --type=merge

    Write-Host "--- Synchronisation déclenchée. En attente que les ressources soient saines... ---"
    kubectl wait --for=jsonpath='{.status.sync.status}=Synced' `
        application/$ROOT_APP_NAME -n $ROOT_APP_NS --timeout=120s
} else {
    Write-Host "--- Root App déjà synchronisée ---"
}

# 5. Lancer le tunnel
Write-Host "--- Lancement du tunnel ---"
# Note : minikube tunnel nécessite des droits administrateur (déjà requis en haut du script)
$tunnelJob = Start-Job -ScriptBlock {
    minikube tunnel
}

# 6. Récupérer l'IP de Traefik
Write-Host "--- Récupération de l'IP de Traefik ---"
$IP = ""
while ([string]::IsNullOrEmpty($IP)) {
    Start-Sleep -Seconds 2
    $IP = kubectl get svc traefik -n $TRAEFIK_NS `
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
}
Write-Host "IP Traefik détectée : $IP"

# 7. Mettre à jour le fichier hosts
$HOSTS_FILE = "C:\Windows\System32\drivers\etc\hosts"

if (Test-Path $DOMAINS_FILE) {
    Write-Host "--- Mise à jour de $HOSTS_FILE ---"

    $domains = Get-Content $DOMAINS_FILE | Where-Object {
        $_ -notmatch '^\s*$' -and $_ -notmatch '^\s*#'
    }

    foreach ($domain in $domains) {
        # Lire le contenu actuel
        $hostsContent = Get-Content $HOSTS_FILE

        # Supprimer les entrées existantes pour ce domaine
        $hostsContent = $hostsContent | Where-Object { $_ -notmatch [regex]::Escape($domain) }

        # Ajouter la nouvelle entrée
        $hostsContent += "$IP $domain"

        # Écrire le fichier mis à jour
        $hostsContent | Set-Content $HOSTS_FILE -Encoding ASCII

        Write-Host "   -> $domain configuré"
    }
}

Write-Host "--- Environnement prêt ! ---"