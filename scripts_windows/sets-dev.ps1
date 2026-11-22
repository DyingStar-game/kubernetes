# Gere les ensembles de services du cluster local (argocd\dev\root\sets\<ensemble>.yaml).
#   sets-dev.ps1 list
#   sets-dev.ps1 add <ensemble>...
#   sets-dev.ps1 remove <ensemble>...   (jamais `core`)
param(
    [Parameter(Mandatory = $true, Position = 0)][ValidateSet('list', 'add', 'remove')][string]$Command,
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Names
)
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')
$ALL_SETS = @('core', 'server', 'server-idle', 'gameplay', 'voice', 'admin', 'observability', 'telepresence')
foreach ($n in $Names) {
    if ($ALL_SETS -notcontains $n) { Write-Error "Ensemble inconnu : $n (existants : $($ALL_SETS -join ', '))"; exit 2 }
}
switch ($Command) {
    'list' {
        foreach ($set in $ALL_SETS) {
            kubectl get application "root-$set" -n argocd 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { "${set}: deploye" } else { "${set}: absent" }
        }
    }
    'add' {
        if (-not $Names) { Write-Error 'Usage: sets-dev.ps1 add <ensemble>...'; exit 2 }
        foreach ($set in $Names) {
            # server / server-idle define the same Application: drop the other root first (its
            # children are kept, the new root adopts them and updates the Application).
            if ($set -eq 'server') { kubectl delete application root-server-idle -n argocd --ignore-not-found }
            if ($set -eq 'server-idle') { kubectl delete application root-server -n argocd --ignore-not-found }
            kubectl apply -f "argocd/dev/root/sets/$set.yaml"
        }
    }
    'remove' {
        if (-not $Names) { Write-Error 'Usage: sets-dev.ps1 remove <ensemble>...'; exit 2 }
        foreach ($set in $Names) {
            if ($set -eq 'core') { Write-Error 'core ne peut pas etre retire.'; exit 2 }
            # La racine d'abord (sinon son selfHeal recree les Applications), puis chaque
            # Application avec le finalizer ArgoCD pour que ses ressources soient supprimees.
            kubectl delete application "root-$set" -n argocd --ignore-not-found
            # Les dossiers de l'ensemble sont lus dans sa racine (argocd/dev/root/sets/<set>.yaml).
            $dirs = Select-String -Path "argocd/dev/root/sets/$set.yaml" -Pattern '^\s*path: (.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value }
            foreach ($f in ($dirs | ForEach-Object { Get-ChildItem "$_/*.yaml" })) {
                $app = (Select-String -Path $f.FullName -Pattern '^  name: (.+)$' | Select-Object -First 1).Matches[0].Groups[1].Value
                kubectl patch application $app -n argocd --type=merge -p '{\"metadata\":{\"finalizers\":[\"resources-finalizer.argocd.argoproj.io\"]}}' 2>$null | Out-Null
                kubectl delete application $app -n argocd --wait=false --ignore-not-found
            }
        }
    }
}
