# get-dev-token.ps1 - Obtient un access token Joueur (password grant) dans le realm
#                     dev-local `dyingstar`. Equivalent Windows de scripts_linux/get-dev-token.sh.
#
# Deux modes :
#   * par defaut        : on CREE un joueur au hasard (pseudo + mot de passe aleatoires,
#                         realm role `player`), puis on en obtient le token. Chaque appel
#                         donne un pseudo different.
#   * -Existing         : on s'authentifie sur un compte EXISTANT (-Username / -Password,
#                         defaut devplayer/devplayer ; les comptes player-kira, player-orin...
#                         ont pour mot de passe leur nom).
#
# Pieges du realm que ce script contourne (les memes que la version Linux) :
#   1. `admin-cli` ne doit JAMAIS servir de client joueur : sans default client scope, Keycloak
#      emet un "lightweight access token" sans sub / preferred_username / realm_access. Le client
#      de dev `dyingstar-dev` (public, directAccessGrants) porte openid/roles/profile/email.
#   2. Le user profile du realm exige email + firstName + lastName : sans eux le password grant
#      echoue en `invalid_grant` / "Account is not fully set up". Le script remplit les trois.
#   3. L'assignation d'un realm role exige {id, name} : on resout l'id avant le POST.
#
# Difference avec la version Linux : le compte existant se donne par PARAMETRE (-Username),
# pas par la variable USERNAME, qui existe toujours sous Windows (c'est la session en cours).
#
# Usage :
#   .\scripts_windows\get-dev-token.ps1                      # joueur aleatoire
#   .\scripts_windows\get-dev-token.ps1 -Raw                 # token brut (pour un $(...))
#   .\scripts_windows\get-dev-token.ps1 -Existing            # compte devplayer
#   .\scripts_windows\get-dev-token.ps1 -Username player-kira -Password player-kira
#
# Passer le token a un client Godot :
#   $t = .\scripts_windows\get-dev-token.ps1 -Raw
#   & godot.exe --path <projet> --token=$t
#
# Sortie (mode defaut) : resume des claims utiles + garde-fous, puis une ligne a copier :
#   $env:PLAYER_TOKEN = '...'
# Sortie (-Raw) : uniquement la chaine access_token.

param(
    [switch]$Raw,
    [switch]$Random,
    [switch]$Existing,
    [string]$Username,
    [string]$Password,
    [string]$Issuer = 'http://auth.dyingstar.local',
    [string]$Realm = 'dyingstar',
    [string]$ClientId = 'dyingstar-dev',
    [string]$Scope = '',
    [string]$Prefix = 'dev-',
    [string]$PlayerRole = 'player',
    [string]$AdminUser = 'admin',
    [string]$AdminPassword = 'devpass'    # DEV ONLY
)

$ErrorActionPreference = 'Stop'

# Un compte designe explicitement (-Username) n'est jamais cree : on s'y authentifie.
$userExplicit = $PSBoundParameters.ContainsKey('Username')
if (-not $Username) { $Username = 'devplayer' }
if (-not $Password) { $Password = $Username }
if (-not $Existing -and -not $userExplicit -and -not $Random) { $Random = $true }

$tokenEndpoint = "$Issuer/realms/$Realm/protocol/openid-connect/token"
$masterEndpoint = "$Issuer/realms/master/protocol/openid-connect/token"
$adminBase = "$Issuer/admin/realms/$Realm"

function Say($text, $color = 'Gray') { if (-not $Raw) { Write-Host $text -ForegroundColor $color } }

# Decode la payload d'un JWT (base64url, padding retabli).
function Get-JwtPayload([string]$jwt) {
    $part = $jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
    switch ($part.Length % 4) { 2 { $part += '==' } 3 { $part += '=' } }
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json
}

# Rend une erreur Keycloak lisible (corps JSON ou texte brut).
function Get-KcError($err) {
    $body = ''
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $body = $err.ErrorDetails.Message }
    if ($body) {
        try {
            $j = $body | ConvertFrom-Json
            if ($j.error_description) { return "$($j.error) - $($j.error_description)" }
            if ($j.error) { return [string]$j.error }
        } catch { }
        return $body
    }
    return $err.Exception.Message
}

function Get-RandomText([int]$length, [string]$alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
    -join (1..$length | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] })
}

# ---------------------------------------------------------------------------
# -Random : creer un joueur aleatoire via l'API admin
# ---------------------------------------------------------------------------
if ($Random) {
    try {
        $admin = Invoke-RestMethod -Method Post -Uri $masterEndpoint -Body @{
            grant_type = 'password'; client_id = 'admin-cli'; username = $AdminUser; password = $AdminPassword
        }
    } catch {
        Write-Error "Echec d'authentification admin (user=$AdminUser) sur le realm master : $(Get-KcError $_)"
        exit 1
    }
    $headers = @{ Authorization = "Bearer $($admin.access_token)" }

    # Politique du realm : >= 10 caracteres, distinct du pseudo et de l'email.
    $pseudo = $Prefix + (Get-RandomText 8)
    $pw = 'Str0ng-' + (Get-RandomText 16 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')

    Say "`n> Creation d'un joueur aleatoire" 'Cyan'
    Say "  pseudo    $pseudo"
    Say "  password  $pw"
    Say "  realm     $Realm   role: $PlayerRole"

    $userJson = @{
        username = $pseudo; enabled = $true; emailVerified = $true
        email = "$pseudo@dyingstar.local"; firstName = 'Dev'; lastName = $pseudo
        credentials = @(@{ type = 'password'; value = $pw; temporary = $false })
    } | ConvertTo-Json -Depth 5

    try {
        $created = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$adminBase/users" -Headers $headers `
            -ContentType 'application/json' -Body $userJson
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) {
            Write-Error "Le pseudo $pseudo existe deja (collision). Relance le script."
        } else {
            Write-Error "Creation de l'utilisateur $pseudo echouee : $(Get-KcError $_)"
        }
        exit 1
    }
    $location = [string]($created.Headers['Location'] | Select-Object -First 1)
    if (-not $location) { Write-Error "Creation de $pseudo : pas d'en-tete Location."; exit 1 }
    $uid = $location.Split('/')[-1]
    Say '  [OK]    utilisateur cree' 'Green'

    # L'API exige {id, name} : name seul renvoie 404.
    try {
        $role = Invoke-RestMethod -Method Get -Uri "$adminBase/roles/$PlayerRole" -Headers $headers
        $mapping = ConvertTo-Json -InputObject @(@{ id = $role.id; name = $PlayerRole })
        Invoke-RestMethod -Method Post -Uri "$adminBase/users/$uid/role-mappings/realm" -Headers $headers `
            -ContentType 'application/json' -Body $mapping | Out-Null
    } catch {
        Write-Error "Assignation du role $PlayerRole echouee : $(Get-KcError $_)"
        exit 1
    }
    Say "  [OK]    realm role $PlayerRole assigne" 'Green'

    $Username = $pseudo
    $Password = $pw
}

# ---------------------------------------------------------------------------
# Password grant sur le client joueur
# ---------------------------------------------------------------------------
$form = @{ grant_type = 'password'; client_id = $ClientId; username = $Username; password = $Password }
if ($Scope) { $form.scope = $Scope }
try {
    $resp = Invoke-RestMethod -Method Post -Uri $tokenEndpoint -Body $form
} catch {
    $reason = Get-KcError $_
    if ($Raw) { [Console]::Error.WriteLine($reason); exit 1 }
    Write-Host "Echec du password grant (client_id=$ClientId, username=$Username)" -ForegroundColor Red
    Write-Host "   $reason"
    Write-Host '   Verifie que le compte a un email, firstName et lastName renseignes (user profile du realm).'
    exit 1
}
$token = $resp.access_token
if (-not $token) { Write-Error "Pas d'access_token dans la reponse."; exit 1 }

if ($Raw) { Write-Output $token; exit 0 }

# ---------------------------------------------------------------------------
# Resume + garde-fous + ligne export
# ---------------------------------------------------------------------------
$payload = Get-JwtPayload $token

Write-Host "`n> Token joueur - client $ClientId" -ForegroundColor Cyan
Write-Host "  endpoint    $tokenEndpoint"
Write-Host "  realm       $Realm"
Write-Host "  utilisateur $Username"

Write-Host "`n> Claims utiles" -ForegroundColor Cyan
$aud = if ($null -eq $payload.aud) { '(absent)' } else { ($payload.aud -join ',') }
$roles = if ($payload.realm_access) { ($payload.realm_access.roles -join ', ') } else { '' }
Write-Host "  azp = $($payload.azp)"
Write-Host "  sub = $($payload.sub)"
Write-Host "  preferred_username = $($payload.preferred_username)"
Write-Host "  email = $($payload.email)"
Write-Host "  realm_access.roles = $roles"
Write-Host "  scope = $($payload.scope)"
Write-Host "  aud = $aud"
if ($payload.exp) {
    $until = [DateTimeOffset]::FromUnixTimeSeconds([long]$payload.exp).LocalDateTime
    Write-Host ("`n  expires_in {0} s (jusqu'au {1})" -f $resp.expires_in, $until.ToString('yyyy-MM-dd HH:mm:ss'))
}

Write-Host "`n> Garde-fous" -ForegroundColor Cyan
if (-not $payload.sub -or -not $payload.preferred_username) {
    Write-Host "  [FAIL]  lightweight token detecte : sub/preferred_username absents (client_id=$ClientId ?)" -ForegroundColor Red
    Write-Host "  [WARN]  Utilise dyingstar-dev, pas admin-cli (aucun default client scope)." -ForegroundColor Yellow
} else {
    Write-Host '  [OK]    claims utilisateur presents (sub + preferred_username)' -ForegroundColor Green
}
if ($null -eq $payload.aud) {
    Write-Host "  [WARN]  claim 'aud' absent : refuse sur /api/internal/* des APIs (azp non allowliste)." -ForegroundColor Yellow
    Write-Host '  [WARN]  Valide pour les endpoints joueur et pour MQTT (JWT en username).' -ForegroundColor Yellow
} else {
    Write-Host "  [OK]    claim 'aud' present : $aud" -ForegroundColor Green
}

Write-Host "`n> Export (copier-coller)" -ForegroundColor Cyan
Write-Host "`$env:PLAYER_TOKEN = '$token'"
Write-Host "`n  Usage : curl.exe -H `"Authorization: Bearer `$env:PLAYER_TOKEN`" ..."
