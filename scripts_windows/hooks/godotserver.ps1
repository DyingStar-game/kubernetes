<#
.SYNOPSIS
    Reproduit en local les traitements que la CI applique aux sources du serveur
    Godot avant le docker build (DyingStar/.github/workflows/build-server-preprod.yaml),
    puis restaure les fichiers touches. Equivalent Windows de
    scripts_linux/hooks/godotserver.sh.

.DESCRIPTION
    Appele par build-and-deploy.ps1, cwd = racine du depot DyingStar :
      -Mode prepare   avant `docker build`
      -Mode cleanup   apres (toujours, meme en cas d'echec)

    -StateDir sert a sauvegarder les fichiers modifies : on ne passe pas par
    `git checkout` pour ne pas ecraser des modifications locales non commitees.

    Variable d'environnement GODOT_STREAM_CHANNEL : valeur de [stream] channel
    dans server.ini (defaut : dev — la CI preprod met "preprod").

    Etapes de la CI et leur equivalent ici :
      - rm -fr assets_blender          -> rien a faire : deja exclu par .dockerignore
      - sed channel dans server.ini    -> prepare (GODOT_STREAM_CHANNEL)
      - dev tools OFF dans globals.gd  -> prepare, avec la meme verification que la CI
      - docker build --no-cache        -> NO_CACHE=1 cote build-and-deploy.ps1
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('prepare', 'cleanup')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$StateDir
)

$ErrorActionPreference = 'Stop'

$StreamChannel = if ($env:GODOT_STREAM_CHANNEL) { $env:GODOT_STREAM_CHANNEL } else { 'dev' }
$DevTools      = @('spawn_wheel', 'zapette', 'toggle_eva', 'build_chunk_skirts')

# Fichiers modifies par prepare — sauvegardes tels quels dans $StateDir.
$Files = @('server.ini', 'scenes/globals/globals.gd')

# Lecture/ecriture sans BOM et en conservant les fins de ligne : Godot et git
# ne doivent voir que le changement de valeur.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Read-Text  ($path)        { [System.IO.File]::ReadAllText($path, $Utf8NoBom) }
function Write-Text ($path, $text) { [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom) }

function Invoke-Prepare {
    foreach ($f in $Files) {
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
            throw "hook godotserver : fichier '$f' introuvable dans $PWD."
        }
        $dest = Join-Path $StateDir $f
        New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
        Copy-Item -LiteralPath $f -Destination $dest -Force
    }

    Write-Host "     - server.ini : [stream] channel = `"$StreamChannel`""
    $ini = Read-Text 'server.ini'
    $ini = [regex]::Replace($ini, '(?m)^(channel = )"[^"]*"', ('${1}"' + $StreamChannel + '"'))
    if ($ini -notmatch ('(?m)^channel = "' + [regex]::Escape($StreamChannel) + '"')) {
        throw 'hook godotserver : channel non applique dans server.ini'
    }
    Write-Text 'server.ini' $ini

    # Globals.ENABLED_DEV_TOOLS est livre ON dans le depot pour les devs ; un build
    # ne doit pas les embarquer. Chaque cle est verifiee apres remplacement : une
    # cle renommee ou supprimee fait echouer le build plutot que d'embarquer l'outil.
    Write-Host "     - globals.gd : dev tools OFF ($($DevTools -join ' '))"
    $gd = Read-Text 'scenes/globals/globals.gd'
    foreach ($tool in $DevTools) {
        $gd = [regex]::Replace($gd, ('(?m)^(\s+"' + $tool + '": )true,'), '${1}false,')
        if ($gd -notmatch ('(?m)^\s+"' + $tool + '": false,')) {
            throw "hook godotserver : dev tool '$tool' non desactive dans globals.gd"
        }
    }
    Write-Text 'scenes/globals/globals.gd' $gd
}

function Invoke-Cleanup {
    foreach ($f in $Files) {
        $src = Join-Path $StateDir $f
        if (Test-Path -LiteralPath $src -PathType Leaf) {
            Copy-Item -LiteralPath $src -Destination $f -Force
            Write-Host "     - $f restaure"
        }
    }
}

switch ($Mode) {
    'prepare' { Invoke-Prepare }
    'cleanup' { Invoke-Cleanup }
}
