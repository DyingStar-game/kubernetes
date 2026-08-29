# =============================================================
#  check-dev.ps1 - Verification des prerequis pour start-dev.ps1
# =============================================================

# Les chemins ci-dessous sont relatifs a la racine du depot, alors que le
# script vit dans scripts_windows\ : on se replace donc a la racine.
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

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
    } catch {
        return $false
    }
}

function Get-ToolVersion ([string]$cmd, [string]$argStr) {
    try {
        $out = & $cmd $argStr.Split(' ') 2>$null | Out-String
        if ($out -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
    } catch {}
    return $null
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Verification des prerequis - environnement dev K8s  " -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# ----------------------------------------------------------
# 1. Outils requis
# ----------------------------------------------------------
Write-Section "1. Outils requis"

$tools = @(
    @{ Cmd = "kubectl";  Args = "version --client"; Min = "1.25.0" },
    @{ Cmd = "minikube"; Args = "version";          Min = "1.30.0" },
    @{ Cmd = "helm";     Args = "version --short";  Min = "3.10.0" },
    @{ Cmd = "docker";   Args = "--version";        Min = "20.10.0" },
    @{ Cmd = "git";      Args = "--version";        Min = "2.30.0" }
)

foreach ($t in $tools) {
    $found = Get-Command $t.Cmd -ErrorAction SilentlyContinue
    if (-not $found) {
        Write-Fail "$($t.Cmd) : non trouve - installez-le et ajoutez-le au PATH"
        continue
    }
    $ver = Get-ToolVersion $t.Cmd $t.Args
    if (-not $ver) {
        Write-Warn "$($t.Cmd) : trouve mais version non detectable"
        continue
    }
    if (Compare-Version $ver $t.Min) {
        Write-Ok "$($t.Cmd) $ver (min: $($t.Min))"
    } else {
        Write-Fail "$($t.Cmd) $ver - version trop ancienne (min: $($t.Min))"
    }
}

# ----------------------------------------------------------
# 2. Ressources systeme
# ----------------------------------------------------------
Write-Section "2. Ressources systeme"

$ram = Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue |
       Measure-Object -Property Capacity -Sum
if ($ram) {
    $ramGB = [math]::Round($ram.Sum / 1GB)
    if ($ramGB -ge 8) {
        Write-Ok "RAM : $ramGB Go"
    } elseif ($ramGB -ge 4) {
        Write-Warn "RAM : $ramGB Go - 8 Go recommandes pour Minikube + ArgoCD"
    } else {
        Write-Fail "RAM : $ramGB Go - minimum 4 Go requis"
    }
} else {
    Write-Warn "RAM : impossible a lire"
}

$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue |
       Measure-Object -Property NumberOfCores -Sum
if ($cpu) {
    $cores = $cpu.Sum
    if ($cores -ge 4) {
        Write-Ok "CPU : $cores coeurs"
    } elseif ($cores -ge 2) {
        Write-Warn "CPU : $cores coeurs - 4 coeurs recommandes"
    } else {
        Write-Fail "CPU : $cores coeur - minimum 2 requis"
    }
} else {
    Write-Warn "CPU : nombre de coeurs non detectable"
}

$sysDrive = $env:SystemDrive
$disk = Get-PSDrive ($sysDrive.TrimEnd(':')) -ErrorAction SilentlyContinue
if ($disk) {
    $freeGB = [math]::Round($disk.Free / 1GB)
    if ($freeGB -ge 20) {
        Write-Ok "Disque libre ($sysDrive) : $freeGB Go"
    } elseif ($freeGB -ge 10) {
        Write-Warn "Disque libre ($sysDrive) : $freeGB Go - 20 Go recommandes"
    } else {
        Write-Fail "Disque libre ($sysDrive) : $freeGB Go - minimum 20 Go requis"
    }
} else {
    Write-Warn "Disque : espace libre non detectable"
}

# ----------------------------------------------------------
# 3. Docker daemon
# ----------------------------------------------------------
Write-Section "3. Docker daemon"

docker info 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Docker daemon : en cours d'execution"
} else {
    Write-Fail "Docker daemon : non demarre ou inaccessible"
    Write-Info "Lancez Docker Desktop ou demarrez le service Docker"
}

# ----------------------------------------------------------
# 4. Virtualisation / Hyper-V / WSL2
# ----------------------------------------------------------
Write-Section "4. Virtualisation"

$hypervFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
if ($hypervFeature -and $hypervFeature.State -eq 'Enabled') {
    Write-Ok "Hyper-V : active"
} else {
    Write-Warn "Hyper-V : non active - Minikube utilisera le driver docker (WSL2 requis)"
}

wsl --status 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Ok "WSL2 : disponible"
} else {
    Write-Warn "WSL2 : non detecte - recommande pour le driver docker de Minikube"
}

# ----------------------------------------------------------
# 5. Droits administrateur
# ----------------------------------------------------------
Write-Section "5. Droits administrateur"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator
)
if ($isAdmin) {
    Write-Ok "Session administrateur : oui"
} else {
    Write-Fail "Session administrateur : non - .\scripts_windows\start-dev.ps1 requiert des droits admin (minikube tunnel + hosts)"
}

# ----------------------------------------------------------
# 6. Connectivite reseau
# ----------------------------------------------------------
Write-Section "6. Connectivite reseau"

$urls = @(
    @{ Url = "https://registry.k8s.io";                                   Label = "registry.k8s.io (images Kubernetes)" },
    @{ Url = "https://harbor.dyingstar-game.space";                       Label = "Harbor dyingstar" },
    @{ Url = "https://argoproj.github.io";                                Label = "ArgoCD Helm repo" },
    @{ Url = "https://github.com/kubernetes-sigs/gateway-api/releases";  Label = "GitHub (Gateway API)" }
)

foreach ($u in $urls) {
    try {
        Invoke-WebRequest -Uri $u.Url -Method Head -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop | Out-Null
        Write-Ok $u.Label
    } catch {
        Write-Fail "$($u.Label) - injoignable (verifiez le proxy/firewall)"
    }
}

# ----------------------------------------------------------
# 7. Fichiers de configuration locaux
# ----------------------------------------------------------
Write-Section "7. Fichiers de configuration locaux"

$requiredFiles = @(
    "argocd\values.yaml",
    "argocd\values-dev.yaml",
    "argocd\root-dev.yaml"
)

foreach ($f in $requiredFiles) {
    if (Test-Path $f) {
        Write-Ok "$f : present"
    } else {
        Write-Fail "$f : manquant"
    }
}

if (Test-Path "hosts_config.txt") {
    Write-Ok "hosts_config.txt : present"
    $domainCount = (Get-Content "hosts_config.txt" |
        Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' }).Count
    Write-Info "$domainCount domaine(s) configure(s)"
} else {
    Write-Warn "hosts_config.txt : absent - aucune entree hosts ne sera creee"
}

# ----------------------------------------------------------
# Bilan
# ----------------------------------------------------------
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan

if ($script:Errors -eq 0 -and $script:Warnings -eq 0) {
    Write-Host "  Tout est pret - vous pouvez lancer .\scripts_windows\start-dev.ps1" -ForegroundColor Green
} elseif ($script:Errors -eq 0) {
    Write-Host "  $($script:Warnings) avertissement(s) - .\scripts_windows\start-dev.ps1 devrait fonctionner" -ForegroundColor Yellow
} else {
    Write-Host "  $($script:Errors) erreur(s) bloquante(s), $($script:Warnings) avertissement(s)" -ForegroundColor Red
    Write-Host "  Corrigez les erreurs avant de lancer .\scripts_windows\start-dev.ps1" -ForegroundColor Red
}

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

exit $script:Errors