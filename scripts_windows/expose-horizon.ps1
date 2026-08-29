<#
.SYNOPSIS
    Expose un service du cluster dev sur l'hote, de facon resistante aux
    redemarrages de pod. Equivalent Windows de expose-horizon.sh.

.DESCRIPTION
    kubectl port-forward s'epingle a UN pod. Quand ce pod est remplace - ce que
    fait .\scripts_windows\build-and-deploy.ps1 a chaque build - le relais casse. Et le
    processus ne meurt pas forcement : il reste la, accepte les connexions
    locales, puis echoue au moment de les transmettre ("lost connection to
    pod"). L'echec est donc silencieux jusqu'a ce qu'un client s'y casse les
    dents.

    Ce script suit le pod precis auquel le relais est attache et le relance des
    que ce pod n'est plus pret. On suit le pod plutot que l'ensemble des
    endpoints : pendant un rolling update les deux pods coexistent brievement,
    et surveiller l'ensemble provoquerait deux relances au lieu d'une.

    L'ecoute se fait par defaut sur 0.0.0.0, pour que d'autres machines du
    reseau puissent se connecter en utilisant l'IP de cet hote. C'est le seul
    chemin possible pour une machine distante : ni l'IP du tunnel minikube ni
    l'IP du node minikube ne sont routables depuis le reste du reseau.

    Note Windows : le pare-feu bloque par defaut les connexions entrantes. Pour
    autoriser les autres machines, en console admin :
      New-NetFirewallRule -DisplayName "DyingStar horizon 7040" `
        -Direction Inbound -Protocol TCP -LocalPort 7040 -Action Allow

.PARAMETER Service
    Nom du Service a exposer (defaut : horizon).

.PARAMETER Port
    Port local d'ecoute. Par defaut, le port du Service.

.PARAMETER Local
    N'ecouter que sur 127.0.0.1 au lieu de 0.0.0.0.

.EXAMPLE
    .\scripts_windows\expose-horizon.ps1
    Expose horizon sur 0.0.0.0, port lu depuis le Service.

.EXAMPLE
    .\scripts_windows\expose-horizon.ps1 -Local
    N'expose que sur 127.0.0.1.

.EXAMPLE
    .\scripts_windows\expose-horizon.ps1 -Service livekit -Port 7880
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Service = 'horizon',

    [Parameter(Position = 1)]
    [int]$Port = 0,

    [switch]$Local
)

$ErrorActionPreference = 'Stop'
if (Test-Path 'variable:PSNativeCommandUseErrorActionPreference') {
    $PSNativeCommandUseErrorActionPreference = $false
}

# Le script vit dans scripts_windows\ : on se replace a la racine du depot.
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

$Namespace       = 'dyingstar'
$ExpectedContext = 'minikube'
$Address = if ($Local) { '127.0.0.1' } else { '0.0.0.0' }

# --- Garde-fou : uniquement le cluster minikube local ------------------------
$currentContext = (kubectl config current-context 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { $currentContext = '' }
if ($currentContext -ne $ExpectedContext) {
    $shown = if ($currentContext) { $currentContext } else { '<aucun>' }
    Write-Host "  [ERREUR]  Le contexte kube courant est '$shown', attendu '$ExpectedContext'." -ForegroundColor Red
    Write-Host "  Lancez : kubectl config use-context $ExpectedContext"
    exit 1
}

# --- Resolution du service et du port ----------------------------------------
$svcPort = (kubectl get svc $Service -n $Namespace -o jsonpath='{.spec.ports[0].port}' 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($svcPort)) {
    Write-Host "  [ERREUR]  Service '$Service' introuvable dans le namespace '$Namespace'." -ForegroundColor Red
    Write-Host "  Services disponibles :"
    kubectl get svc -n $Namespace --no-headers 2>$null | ForEach-Object {
        Write-Host ("     " + ($_ -split '\s+')[0])
    }
    exit 1
}
if ($Port -eq 0) { $Port = [int]$svcPort }

# Pods prets derriere le service, dans l'ordre renvoye par l'EndpointSlice.
function Get-ReadyPods {
    $jsonpath = '{range .items[*].endpoints[?(@.conditions.ready==true)]}{.targetRef.name}{" "}{end}'
    $out = kubectl get endpointslice -n $Namespace -l "kubernetes.io/service-name=$Service" -o jsonpath=$jsonpath 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($out)) { return @() }
    return @(($out | Out-String).Trim() -split '\s+' | Where-Object { $_ })
}

Write-Host "  Relais vers ${Service}:${svcPort} (namespace $Namespace)" -ForegroundColor Cyan
if ($Address -eq '0.0.0.0') {
    $lanIp = $null
    try {
        $lanIp = (Get-NetIPConfiguration |
                  Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
                  Select-Object -First 1).IPv4Address.IPAddress
    } catch { }
    if (-not $lanIp) { $lanIp = '<ip-de-cet-hote>' }
    Write-Host "     Depuis une autre machine : ws://${lanIp}:${Port}"
}
Write-Host "     Depuis cet hote          : ws://127.0.0.1:${Port}"
Write-Host "     (Ctrl-C pour arreter)"
Write-Host ""

# --- Boucle de supervision ---------------------------------------------------
$proc = $null
try {
    while ($true) {
        $pod = Get-ReadyPods | Select-Object -First 1
        if (-not $pod) {
            Write-Host "  Aucun pod pret pour '$Service' - nouvelle tentative dans 3s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
            continue
        }

        Write-Host "  Relais actif  ${Address}:${Port}  ->  ${pod}:${svcPort}" -ForegroundColor Green
        $proc = Start-Process -FilePath 'kubectl' -PassThru -NoNewWindow -ArgumentList @(
            'port-forward', '--address', $Address, '-n', $Namespace,
            "pod/$pod", "${Port}:${svcPort}"
        )

        # On relance des que le processus meurt OU que le pod suivi n'est plus
        # pret : port-forward peut survivre au remplacement du pod tout en etant
        # devenu inutilisable, et il faut alors le tuer nous-memes.
        while (-not $proc.HasExited) {
            Start-Sleep -Seconds 2
            if ((Get-ReadyPods) -notcontains $pod) {
                Write-Host "  Pod $pod remplace - relance du relais" -ForegroundColor Yellow
                $proc | Stop-Process -Force -ErrorAction SilentlyContinue
                break
            }
        }

        $proc | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
        $proc = $null
        Start-Sleep -Seconds 1
    }
}
finally {
    Write-Host ""
    Write-Host "  Arret du relais."
    if ($proc -and -not $proc.HasExited) {
        $proc | Stop-Process -Force -ErrorAction SilentlyContinue
    }
}
