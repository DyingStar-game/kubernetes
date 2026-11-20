# Points the stack's names at one address in the Windows hosts file.
#
# Started by the dev panel through the system's elevation prompt: writing this file is the one
# thing in the relay network path that needs administrator rights, and it is needed once.
#
#   setup-hosts.ps1 -Ip 127.0.0.1 -Names horizon.dyingstar.local,auth.dyingstar.local
#
# A line that already gives one of the names another address is replaced; nothing else in the
# file is touched. The file is often locked for a moment by an antivirus: reads and writes retry.

param(
    [Parameter(Mandatory = $true)][string]$Ip,
    [Parameter(Mandatory = $true)][string]$Names
)

$ErrorActionPreference = 'Stop'
$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'

if ($Ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Write-Error "not an address: $Ip"; exit 2 }
$list = @($Names -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($name in $list) {
    if ($name -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') { Write-Error "not a host name: $name"; exit 2 }
}

function Invoke-WithRetry([scriptblock]$Action) {
    for ($i = 0; $i -lt 8; $i++) {
        try { return & $Action } catch { Start-Sleep -Milliseconds 300 }
    }
    return & $Action
}

$lines = @(Invoke-WithRetry { Get-Content -LiteralPath $hostsFile -ErrorAction Stop })
$kept = foreach ($line in $lines) {
    $body = ($line -replace '#.*$', '').Trim()
    $parts = @($body -split '\s+' | Where-Object { $_ })
    $mentions = $false
    if ($parts.Count -ge 2) {
        foreach ($name in $list) { if ($parts[1..($parts.Count - 1)] -contains $name) { $mentions = $true } }
    }
    if (-not $mentions) { $line }
}
$new = @($kept) + ($list | ForEach-Object { "$Ip $_" })

Invoke-WithRetry { Set-Content -LiteralPath $hostsFile -Value $new -Encoding ASCII -ErrorAction Stop }
Write-Host "hosts file updated: $($list.Count) name(s) -> $Ip"
