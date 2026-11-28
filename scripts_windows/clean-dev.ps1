#Requires -RunAsAdministrator

# Le script vit dans scripts_windows\ : on se replace a la racine du depot.
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

$K3D_CLUSTER = if ($env:K3D_CLUSTER) { $env:K3D_CLUSTER } else { "dyingstar" }

Write-Host "--- Nettoyage complet de k3d (cluster $K3D_CLUSTER) ---"

# 0. Deconnecter Telepresence
if (Get-Command telepresence -ErrorAction SilentlyContinue) {
    Write-Host "Déconnexion de Telepresence..."
    telepresence quit -s 2>$null | Out-Null
}

# 1. Supprimer le cluster (noeuds, load balancer, reseau et volumes avec)
k3d cluster delete $K3D_CLUSTER

Write-Host "Nettoyage terminé. Vous pouvez relancer .\scripts_windows\start-dev.ps1."
