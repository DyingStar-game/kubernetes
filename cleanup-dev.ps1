#Requires -RunAsAdministrator

Write-Host "--- Nettoyage complet de Minikube ---"

# 1. Arrêter et supprimer le cluster
minikube delete --all

# 2. Tuer les processus Minikube persistants
Write-Host "Arrêt des processus persistants..."

$processNames = @("minikube")
foreach ($name in $processNames) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  Arrêt du processus : $($_.Name) (PID $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}

# Tuer aussi les processus dont la ligne de commande contient "minikube mount"
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*minikube*" } |
    ForEach-Object {
        Write-Host "  Arrêt du processus lié à minikube : $($_.Name) (PID $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

# 3. Nettoyer les points de montage résiduels (WSL2 / minikube mount)
Write-Host "Vérification des montages résiduels..."

# Montages WSL exposés via minikube mount (visible dans les jobs PowerShell)
Get-Job | Where-Object { $_.State -eq 'Running' } | ForEach-Object {
    Write-Host "  Arrêt du job PowerShell en arrière-plan : $($_.Name) (ID $($_.Id))"
    Stop-Job -Id $_.Id
    Remove-Job -Id $_.Id -Force
}

# Si WSL2 est utilisé, tenter un démontage des points liés à minikube
$wslMounts = wsl -- mount 2>$null | Select-String "minikube"
if ($wslMounts) {
    Write-Host "  Points de montage WSL détectés, tentative de démontage..."
    $wslMounts | ForEach-Object {
        $mountPoint = ($_ -split '\s+')[2]
        wsl -- sudo umount -l $mountPoint 2>$null
        Write-Host "  -> Démontage : $mountPoint"
    }
}

# 4. Suppression optionnelle du cache Minikube
# Décommenter les lignes suivantes pour repartir de zéro
Write-Host "Suppression du répertoire cache ~/.minikube/cache (optionnel)..."
# $minikubeCache = Join-Path $env:USERPROFILE ".minikube\cache"
# if (Test-Path $minikubeCache) {
#     Remove-Item -Recurse -Force $minikubeCache
#     Write-Host "  -> Cache supprimé : $minikubeCache"
# }

Write-Host "Nettoyage terminé. Vous pouvez relancer start-dev.ps1."
