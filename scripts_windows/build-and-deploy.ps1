<#
.SYNOPSIS
    Build une image DyingStar depuis les sources locales et la deploie dans la
    stack minikube/ArgoCD (remplace Skaffold). Equivalent Windows de
    build-and-deploy.sh.

.DESCRIPTION
    Les cibles sont decrites dans dev-projects.yaml. Une cible vise soit le
    container principal d'un Deployment, soit un de ses init containers (champ
    `initContainer`, ex. les images horizon-plugins / horizon-data recopiees
    dans un emptyDir partage).

    ArgoCD gere le dev avec selfHeal: true. Pour que le patch ne soit pas annule
    au reconcile suivant, chaque Application dev correspondante declare un bloc
    `ignoreDifferences` sur l'image et l'imagePullPolicy (argocd/dev/game/*.yaml).

.PARAMETER Target
    Nom d'une cible de dev-projects.yaml, ou "all". Si omis, un menu interactif
    est propose.

.EXAMPLE
    .\scripts_windows\build-and-deploy.ps1
    Affiche le menu interactif.

.EXAMPLE
    .\scripts_windows\build-and-deploy.ps1 horizon-data
    Rebuild et deploie la seule image horizon-data.

.EXAMPLE
    .\scripts_windows\build-and-deploy.ps1 all
    Rebuild et deploie toutes les cibles.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Target
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.3+ peut transformer le stderr des commandes natives en erreurs
# terminantes. kubectl et minikube ecrivent des avertissements benins sur stderr :
# on desactive ce comportement et on controle $LASTEXITCODE explicitement.
if (Test-Path 'variable:PSNativeCommandUseErrorActionPreference') {
    $PSNativeCommandUseErrorActionPreference = $false
}

$ConfigFile      = 'dev-projects.yaml'
$ExpectedContext = 'minikube'

# --- Helpers d'affichage -----------------------------------------------------

function Write-Step  ($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "  [OK]  $msg" -ForegroundColor Green }
function Write-Fail  ($msg) { Write-Host "  [ERREUR]  $msg" -ForegroundColor Red }

function Assert-LastExitCode {
    param([string]$Message)
    if ($LASTEXITCODE -ne 0) {
        throw "$Message (code de sortie $LASTEXITCODE)"
    }
}

# --- Lecture de dev-projects.yaml --------------------------------------------

# Retire les guillemets englobants d'une valeur scalaire YAML.
function Format-YamlScalar {
    param([string]$Value)

    $v = $Value.Trim()
    if ($v.Length -ge 2) {
        if (($v.StartsWith('"') -and $v.EndsWith('"')) -or
            ($v.StartsWith("'") -and $v.EndsWith("'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
    }
    return $v
}

# Parseur minimal, volontairement limite au sous-ensemble de YAML utilise par
# dev-projects.yaml : des scalaires de premier niveau, et une liste de mappings
# plats sous `projects:`. On evite ainsi une dependance a python3/PyYAML ou au
# module powershell-yaml, absents d'une machine Windows par defaut.
function Read-DevProjects {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Le fichier de configuration '$Path' est introuvable."
    }

    $config   = @{ namespace = 'default'; tag = 'dev' }
    $entries  = New-Object System.Collections.ArrayList
    $current  = $null

    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        # Commentaire de fin de ligne (aucune valeur de ce fichier ne contient '#')
        $line = $rawLine -replace '\s+#.*$', ''
        if ($line -match '^\s*(#|$)') { continue }

        # Debut d'une entree de liste : "  - name: godotserver"
        if ($line -match '^\s*-\s*(?<key>[A-Za-z][\w-]*)\s*:\s*(?<value>.*)$') {
            if ($null -ne $current) { [void]$entries.Add($current) }
            $current = @{}
            $current[$Matches['key']] = Format-YamlScalar $Matches['value']
            continue
        }

        # Cle indentee rattachee a l'entree de liste courante
        if ($line -match '^\s+(?<key>[A-Za-z][\w-]*)\s*:\s*(?<value>.*)$') {
            if ($null -eq $current) {
                throw "Ligne inattendue dans '$Path' (cle indentee hors d'une entree de liste) : $rawLine"
            }
            $current[$Matches['key']] = Format-YamlScalar $Matches['value']
            continue
        }

        # Cle de premier niveau
        if ($line -match '^(?<key>[A-Za-z][\w-]*)\s*:\s*(?<value>.*)$') {
            if ($null -ne $current) { [void]$entries.Add($current); $current = $null }
            $key = $Matches['key']
            if ($key -eq 'projects') { continue }   # ouvre la liste
            $config[$key] = Format-YamlScalar $Matches['value']
            continue
        }

        throw "Ligne non reconnue dans '$Path' : $rawLine"
    }
    if ($null -ne $current) { [void]$entries.Add($current) }

    $projects = New-Object System.Collections.ArrayList
    foreach ($e in $entries) {
        foreach ($required in 'name', 'path', 'dockerfile', 'deployment') {
            if (-not $e.ContainsKey($required)) {
                throw "Entree incomplete dans '$Path' : champ '$required' manquant (entree '$($e['name'])')."
            }
        }

        $image = $e['name']
        if ($e.ContainsKey('image')) { $image = $e['image'] }

        $init = ''
        if ($e.ContainsKey('initContainer')) { $init = $e['initContainer'] }

        [void]$projects.Add([pscustomobject]@{
            Name          = $e['name']
            Path          = $e['path']
            Dockerfile    = $e['dockerfile']
            Deployment    = $e['deployment']
            Image         = $image
            InitContainer = $init
            Namespace     = $config['namespace']
            Tag           = $config['tag']
        })
    }

    if ($projects.Count -eq 0) {
        throw "Aucun projet declare dans '$Path'."
    }
    return $projects
}

# Libelle d'une cible pour le menu et l'aide.
function Get-TargetLabel {
    param([pscustomobject]$Project)

    if ($Project.InitContainer) {
        return "$($Project.Name)  ->  init container '$($Project.InitContainer)' de '$($Project.Deployment)'"
    }
    return "$($Project.Name)  ->  deployment '$($Project.Deployment)'"
}

function Show-Usage {
    param([pscustomobject[]]$Projects)

    Write-Host "Usage : .\scripts_windows\build-and-deploy.ps1 [cible|all]"
    Write-Host ""
    Write-Host "Cibles disponibles dans '$ConfigFile' :"
    foreach ($p in $Projects) { Write-Host "  $(Get-TargetLabel $p)" }
    Write-Host "  all  ->  toutes les cibles"
}

# --- Build et deploiement d'une cible ----------------------------------------

function Invoke-BuildAndDeploy {
    param([pscustomobject]$Project)

    $imageRef = '{0}:{1}' -f $Project.Image, $Project.Tag

    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "  Traitement de : $($Project.Name)" -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $Project.Path -PathType Container)) {
        throw "Le repertoire '$($Project.Path)' n'existe pas."
    }
    $dockerfilePath = Join-Path $Project.Path $Project.Dockerfile
    if (-not (Test-Path -LiteralPath $dockerfilePath -PathType Leaf)) {
        throw "Le Dockerfile '$dockerfilePath' n'existe pas."
    }

    Write-Step "Build de l'image $imageRef..."
    docker build -t $imageRef -f $dockerfilePath $Project.Path
    Assert-LastExitCode "Le build de l'image $imageRef a echoue"

    # Cible du patch : un init container nomme, ou le container principal.
    # On utilise un strategic merge patch : `name` est la merge key de containers
    # et initContainers, donc pas d'index a calculer (celui des init containers de
    # horizon depend du nombre d'entrees `dependsOn` dans les values).
    $deployRaw = kubectl get deployment $Project.Deployment -n $Project.Namespace -o json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($deployRaw)) {
        throw "Deployment '$($Project.Deployment)' introuvable dans le namespace '$($Project.Namespace)'." +
              " La stack est-elle demarree ? Lancez .\scripts_windows\start-dev.ps1"
    }
    $deploy = $deployRaw | ConvertFrom-Json

    if ($Project.InitContainer) {
        $listKey = 'initContainers'
        $containerName = $Project.InitContainer

        $initNames = @($deploy.spec.template.spec.initContainers | ForEach-Object { $_.name })
        if ($initNames -notcontains $containerName) {
            throw "Init container '$containerName' absent du deployment '$($Project.Deployment)'." +
                  " Verifiez que l'image correspondante est activee dans les values (ex. dataImage.enabled)."
        }
    }
    else {
        $listKey = 'containers'
        $containerName = $deploy.spec.template.spec.containers[0].name
    }

    $genBefore = $deploy.metadata.generation

    # Le JSON passe par un fichier temporaire : le quoting des arguments des
    # commandes natives est peu fiable sous Windows (surtout en PowerShell 5.1)
    # et mangerait les guillemets du patch.
    $patchJson = @{
        spec = @{
            template = @{
                spec = @{
                    $listKey = @(
                        @{
                            name            = $containerName
                            image           = $imageRef
                            imagePullPolicy = 'Never'
                        }
                    )
                }
            }
        }
    } | ConvertTo-Json -Depth 10 -Compress

    $patchFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ds-patch-{0}.json" -f [guid]::NewGuid().ToString('N'))
    try {
        # Sans BOM : kubectl rejette un fichier JSON qui en contient un.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($patchFile, $patchJson, $utf8NoBom)

        Write-Step "Patch de $($Project.Deployment) ($listKey/$containerName)..."
        kubectl patch deployment $Project.Deployment -n $Project.Namespace --patch-file $patchFile
        Assert-LastExitCode "Le patch du deployment $($Project.Deployment) a echoue"
    }
    finally {
        Remove-Item -LiteralPath $patchFile -Force -ErrorAction SilentlyContinue
    }

    $genAfter = kubectl get deployment $Project.Deployment -n $Project.Namespace -o jsonpath='{.metadata.generation}'
    Assert-LastExitCode "Lecture de la generation du deployment $($Project.Deployment)"

    # Le tag est stable (:dev). Quand seul le *contenu* de l'image change, le pod
    # template reste identique : le patch est un no-op, aucun rollout n'est
    # declenche et le pod continue de tourner sur l'ancienne image. Dans ce cas il
    # faut forcer le redemarrage - mais uniquement dans ce cas, sinon un patch qui
    # change reellement l'image provoquerait deux rollouts d'affilee.
    if ("$genBefore" -eq "$genAfter") {
        Write-Step "Pod template inchange (tag stable) - redemarrage force du pod..."
        kubectl rollout restart "deployment/$($Project.Deployment)" -n $Project.Namespace
        Assert-LastExitCode "Le redemarrage du deployment $($Project.Deployment) a echoue"
    }

    Write-Step "Attente du rollout..."
    kubectl rollout status "deployment/$($Project.Deployment)" -n $Project.Namespace --timeout=300s
    Assert-LastExitCode "Le rollout du deployment $($Project.Deployment) a echoue"

    Write-Ok "Termine pour $($Project.Name) !"
}

# --- Programme principal -----------------------------------------------------

Push-Location -LiteralPath (Join-Path $PSScriptRoot '..')
try {
    $projects = Read-DevProjects -Path $ConfigFile

    # --- 1. Determination de la cible ----------------------------------------
    $targetName = $Target
    if ([string]::IsNullOrWhiteSpace($targetName)) {
        if ([Console]::IsInputRedirected) {
            Write-Fail "Aucune cible fournie et pas de terminal interactif."
            Write-Host ""
            Show-Usage -Projects $projects
            exit 1
        }

        Write-Host "Aucune cible fournie - que voulez-vous rebuilder ?"
        Write-Host ""
        for ($i = 0; $i -lt $projects.Count; $i++) {
            Write-Host ("  {0,2}) {1}" -f ($i + 1), (Get-TargetLabel $projects[$i]))
        }
        Write-Host ("  {0,2}) all  ->  toutes les cibles" -f ($projects.Count + 1))
        Write-Host ""

        while (-not $targetName) {
            $answer = Read-Host "Votre choix (numero, Ctrl-C pour annuler)"
            if ([string]::IsNullOrWhiteSpace($answer)) {
                Write-Host "Annule - aucune cible selectionnee."
                exit 1
            }
            $index = 0
            if ([int]::TryParse($answer.Trim(), [ref]$index) -and
                $index -ge 1 -and $index -le ($projects.Count + 1)) {
                if ($index -eq $projects.Count + 1) { $targetName = 'all' }
                else { $targetName = $projects[$index - 1].Name }
            }
            else {
                Write-Host "Choix invalide." -ForegroundColor Yellow
            }
        }
        Write-Host ""
    }

    # --- 2. Selection des projets a traiter ----------------------------------
    if ($targetName -eq 'all') {
        $selected = $projects
    }
    else {
        $selected = @($projects | Where-Object { $_.Name -eq $targetName })
        if ($selected.Count -eq 0) {
            Write-Fail "Cible '$targetName' introuvable dans '$ConfigFile'."
            Write-Host ""
            Show-Usage -Projects $projects
            exit 1
        }
    }

    # --- 3. Garde-fou : uniquement le cluster minikube local -----------------
    # Le script force imagePullPolicy: Never - l'executer sur preprod/prod
    # casserait les deploiements (aucune image locale sur ces noeuds).
    $currentContext = (kubectl config current-context 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { $currentContext = '' }
    if ($currentContext -ne $ExpectedContext) {
        $shown = if ($currentContext) { $currentContext } else { '<aucun>' }
        Write-Fail "Le contexte kube courant est '$shown', attendu '$ExpectedContext'."
        Write-Host "  Lancez : kubectl config use-context $ExpectedContext"
        exit 1
    }

    # --- 4. Build dans le daemon Docker de minikube --------------------------
    Write-Step "Connexion au daemon Docker de Minikube..."
    $dockerEnv = minikube -p minikube docker-env --shell powershell
    Assert-LastExitCode "Impossible de recuperer l'environnement Docker de Minikube"
    $dockerEnv | Invoke-Expression

    # Requis : .docker/Dockerfile.plugins utilise --mount=type=cache et le
    # Dockerfile de resourcesDynamic declare une directive « # syntax= ».
    $env:DOCKER_BUILDKIT = '1'

    foreach ($project in $selected) {
        Invoke-BuildAndDeploy -Project $project
    }

    Write-Host ""
    Write-Host "  Operation terminee avec succes !" -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Fail $_.Exception.Message
    exit 1
}
finally {
    Pop-Location
}
