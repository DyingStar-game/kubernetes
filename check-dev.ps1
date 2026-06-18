# =============================================================
#  check-prereqs.ps1 — Vérification des prérequis pour start.ps1
# =============================================================

$ErrorActionPreference = "SilentlyContinue"

$script:Errors   = 0
$script:Warnings = 0

function Write-Ok   ($msg) { Write-Host "  [OK]    $msg" -ForegroundColor Green }
function Write-Fail ($msg) { Write-Host "  [FAIL]  $msg" -ForegroundColor Red;    $script:Errors++ }
function Write-Warn ($msg) { Write-Host "  [WARN]  $msg" -ForegroundColor Yellow; $script:Warnings++ }
function Write-Info ($msg) { Write-Host "  [INFO]  $msg" -ForegroundColor Cyan }
function Write-Section ($title) { Write-Host "`n  $title" -ForegroundColor Cyan }

function Compare-Version ([string]$current, [string]$minimum) {
    try {
        $c = [Version]($current -replace '^v','')
        $m = [Version]($minimum -replace '^v','')
        return $c -ge $m
    } catch { return $false }
}

function Get-ToolVersion ([string]$cmd, [string]$args) {
    try {
        $out = & $cmd $args.Split(' ') 2>$null | Out-String
        if ($out -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
    } catch {}
    return $null
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Vérification des prérequis — environnement dev K8s  " -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# ----------------------------------------------------------
# 1. Outils requis
# ----------------------------------------------------------
Write-Section "Outils requis"

$tools = @(
    @{ Cmd = "kubectl";   Args = "version --client";  Min = "1.25.0" },
    @{ Cmd = "minikube";  Args = "version";            Min = "1.30.0" },
    @{ Cmd = "helm";      Args = "version --short";   Min = "3.10.0" },
    @{ Cmd = "docker";    Args = "--version";          Min = "20.10.0" },
    @{ Cmd = "git";       Args = "--version";          Min = "2.30.0" }
)

foreach ($t in $tools) {
    $path = Get-Command $t.Cmd -ErrorAction SilentlyContinue
    if (-not $path) {
        Write-Fail "$($t.Cmd) : non trouvé — installez-le et ajoutez-le au PATH"
        continue
    }
    $ver = Get-ToolVersion $t.Cmd $t.Args
    if (-not $ver) {
        Write-Warn "$($t.Cmd) : trouvé mais version non détectable"
        continue
    }
    if (Compare-Version $ver $t.Min) {
        Write-Ok "$($t.Cmd) $ver (min: $($t.Min))"
    } else {
        Write-Fail "$($t.Cmd) $ver — version trop ancienne (min: $($t.Min))"
    }
}

# ----------------------------------------------------------
# 2. Ressources système
# ----------------------------------------------------------
Write-Section "Ressources système"

# RAM
$ram = Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue |
       Measure-Object -Property Capacity -Sum
if ($ram) {
    $ramGB = [math]::Round($ram.Sum / 1GB)
    if ($ramGB -ge 8)     { Write-Ok   "RAM : $ramGB Go" }
    elseif ($ramGB -ge 4) { Write-Warn "RAM : $ramGB Go — 8 Go recommandés pour Minikube + ArgoCD" }
    else                  { Write-Fail "RAM : $ramGB Go — minimum 4 Go requis" }
} else {
    Write-Warn "RAM : impossible à lire"
}

# CPU
$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue |
       Measure-Object -Property NumberOfCores -Sum
if ($cpu) {
    $cores = $cpu.Sum
    if ($cores -ge 4)     { Write-Ok   "CPU : $cores cœurs" }
    elseif ($cores -ge 2) { Write-Warn "CPU : $cores cœurs — 4 cœurs recommandés" }
    else                  { Write-Fail "CPU : $cores cœur — minimum 2 requis" }
} else {
    Write-Warn "CPU : nombre de cœurs non détectable"
}

# Disque (lecteur système)
$sysDrive = $env:SystemDrive
$disk = Get-PSDrive ($sysDrive.TrimEnd(':')) -ErrorAction SilentlyContinue
if ($disk) {
    $freeGB = [math]::Round($disk.Free / 1GB)
    if ($freeGB -ge 20)     { Write-Ok   "Disque libre ($sysDrive) : $freeGB Go" }
    elseif ($freeGB -ge 10) { Write-Warn "Disque libre ($sysDrive) : $freeGB Go — 20 Go recommandés" }
    else                    { Write-Fail "Disque libre ($sysDrive) : $freeGB Go — minimum 20 Go requis" }
} else {
    Write-Warn "Disque : espace libre non détectable"
}

# ----------------------------------------------------------
# 3. Docker daemon
# ----------------------------------------------------------
Write-Section "Docker daemon"

$dockerInfo = docker info 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Docker daemon : en cours d'exécution"
} else {
    Write-Fail "Docker daemon : non démarré ou inaccessible"
    Write-Info "Lancez Docker Desktop ou démarrez le service Docker"
}

# ----------------------------------------------------------
# 4. Virtualisation / Hyper-V / WSL2
# ----------------------------------------------------------
Write-Section "Virtualisation"

$hypervFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
if ($hypervFeature -and $hypervFeature.State -eq 'Enabled') {
    Write-Ok "Hyper-V : activé"
} else {
    Write-Warn "Hyper-V : non activé — Minikube utilisera le driver docker (WSL2 requis)"
}

$wsl = wsl --status 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Ok "WSL2 : disponible"
} else {
    Write-Warn "WSL2 : non détecté — recommandé pour le driver docker de Minikube"
}

# ----------------------------------------------------------
# 5. Droits administrateur
# ----------------------------------------------------------
Write-Section "Droits administrateur"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator
)
if ($isAdmin) {
    Write-Ok "Session administrateur : oui"
} else {
    Write-Fail "Session administrateur : non — start.ps1 requiert des droits admin (minikube tunnel + hosts)"
}

# ----------------------------------------------------------
# 6. Connectivité réseau
# ----------------------------------------------------------
Write-Section "Connectivité réseau"

$urls = @(
    @{ Url = "https://registry.k8s.io";                                       Label = "registry.k8s.io (images Kubernetes)" },
    @{ Url = "https://harbor.dyingstar-game.space";                           Label = "Harbor" },
    @{ Url = "https://argoproj.github.io";                                    Label = "ArgoCD Helm repo" },
    @{ Url = "https://github.com/kubernetes-sigs/gateway-api/releases";      Label = "GitHub (Gateway API)" }
)

foreach ($u in $urls) {
    try {
        $resp = Invoke-WebRequest -Uri $u.Url -Method Head -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Ok $u.Label
    } catch {
        Write-Fail "$($u.Label) — injoignable (vérifiez le proxy/firewall)"
    }
}

# ----------------------------------------------------------
# 7. Fichiers de configuration locaux
# ----------------------------------------------------------
Write-Section "Fichiers de configuration locaux"

$requiredFiles = @(
    "argocd\values.yaml",
    "argocd\values-dev.yaml",
    "argocd\root-app-dev.yaml"
)

foreach ($f in $requiredFiles) {
    if (Test-Path $f) { Write-Ok "$f : présent" }
    else              { Write-Fail "$f : manquant" }
}

if (Test-Path "hosts_config.txt") {
    Write-Ok "hosts_config.txt : présent"
    $domainCount = (Get-Content "hosts_config.txt" | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' }).Count
    Write-Info "$domainCount domaine(s) configuré(s)"
} else {
    Write-Warn "hosts_config.txt : absent — aucune entrée hosts ne sera créée"
}

# ----------------------------------------------------------
# Bilan
# ----------------------------------------------------------
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
if ($script:Errors -eq 0 -and $script:Warnings -eq 0) {
    Write-Host "  Tout est pret — vous pouvez lancer start.ps1" -ForegroundColor Green
} elseif ($script:Errors -eq 0) {
    Write-Host "  $($script:Warnings) avertissement(s) — start.ps1 devrait fonctionner" -ForegroundColor Yellow
} else {
    Write-Host "  $($script:Errors) erreur(s) bloquante(s), $($script:Warnings) avertissement(s)" -ForegroundColor Red
    Write-Host "  Corrigez les erreurs avant de lancer start-dev.ps1" -ForegroundColor Red
}
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

exit $script:Errors