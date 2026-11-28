#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Nettoie TOUT l'environnement dev local.
.DESCRIPTION
    - cluster k3d (noeuds, load balancer, reseau, volumes) et ses restes Docker
    - restes d'un ancien minikube (cluster, conteneur, reseau, volume) s'il y en a
    - contextes / clusters / users kube correspondants dans le kubeconfig
    - entrees du fichier hosts ajoutees par start-dev.ps1
    - session Telepresence encore active
    -Prune supprime aussi le cache de build Docker et les images orphelines (dangling) ;
    il ne touche pas aux images nommees ni aux autres projets.
    Variable : K3D_CLUSTER (defaut : dyingstar).
#>
param([switch]$Prune)

# Le script vit dans scripts_windows\ : on se replace a la racine du depot.
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

$K3D_CLUSTER = if ($env:K3D_CLUSTER) { $env:K3D_CLUSTER } else { "dyingstar" }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "--- Nettoyage complet de l'environnement dev (cluster $K3D_CLUSTER) ---"

# 0. Telepresence
if (Have telepresence) {
    Write-Host "Déconnexion de Telepresence..."
    telepresence quit -s 2>$null | Out-Null
}

# 0b. Entrees du fichier hosts ajoutees par start-dev.ps1
$HOSTS_FILE = "C:\Windows\System32\drivers\etc\hosts"
if ((Test-Path hosts_config.txt) -and (Test-Path $HOSTS_FILE)) {
    $domains = Get-Content hosts_config.txt | Where-Object { $_ -notmatch '^\s*$' -and $_ -notmatch '^\s*#' }
    $lines = Get-Content $HOSTS_FILE | Where-Object {
        $line = $_
        -not ($domains | Where-Object { $line -match [regex]::Escape($_) })
    }
    try { Set-Content -Path $HOSTS_FILE -Value $lines -ErrorAction Stop; Write-Host "   entrées hosts retirées" }
    catch { Write-Host "   (hosts ignoré : $($_.Exception.Message))" }
}

# 1. Cluster k3d
if (Have k3d) {
    k3d cluster delete $K3D_CLUSTER 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "   (cluster $K3D_CLUSTER absent)" }
}

# 2. Restes Docker de k3d + 3. ancien minikube (heritage) et ses relais
if (Have docker) {
    docker ps -aq --filter "name=^k3d-$K3D_CLUSTER-" 2>$null | ForEach-Object {
        docker rm -f $_ 2>$null | Out-Null; Write-Host "   conteneur k3d supprimé : $_"
    }
    docker network rm "k3d-$K3D_CLUSTER" 2>$null | Out-Null
    docker volume rm "k3d-$K3D_CLUSTER-images" 2>$null | Out-Null
}
if (Have minikube) {
    Write-Host "Ancien minikube détecté : suppression..."
    minikube delete --all 2>$null | Out-Null
}
if (Have docker) {
    foreach ($c in @('minikube', 'traefik-http-relay', 'traefik-https-relay', 'horizon-wt-relay')) {
        docker rm -f $c 2>$null | Out-Null
    }
    docker network rm minikube 2>$null | Out-Null
    docker volume rm minikube 2>$null | Out-Null
}
Get-Process -Name minikube -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 4. kubeconfig : contextes, clusters et users du dev local (jamais ceux d'un autre cluster)
if (Have kubectl) {
    foreach ($name in @("k3d-$K3D_CLUSTER", 'minikube')) {
        kubectl config delete-context $name 2>$null | Out-Null
        kubectl config delete-cluster $name 2>$null | Out-Null
        kubectl config unset "users.$name" 2>$null | Out-Null
        kubectl config unset "users.admin@$name" 2>$null | Out-Null
    }
}

# 5. Option : cache de build et images orphelines (rien d'autre)
if ($Prune -and (Have docker)) {
    Write-Host "Nettoyage du cache de build Docker et des images orphelines..."
    docker builder prune -f 2>$null | Out-Null
    docker image prune -f 2>$null | Out-Null
}

Write-Host "Nettoyage terminé. Vous pouvez relancer .\scripts_windows\start-dev.ps1."
