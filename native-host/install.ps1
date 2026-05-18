# YouTube Live Chat Translator — Native Host installer (Windows, user scope).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <CHROME_EXTENSION_ID>
#
# The ExtensionId default is the canonical ID derived from extension/manifest.json:key.
# Override only if you re-keyed the extension.
#
# Effects:
#   - Generates host.bat wrapper so Chrome can spawn `node dist\host.js`
#   - Rewrites manifest.json with absolute path and extension origin
#   - Registers HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ylct.translator
#
# Uninstall:
#   Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ylct.translator"

param(
    [string]$ExtensionId = "glcmldcajgllcmlldojlbhdkaficlheo"
)

$ErrorActionPreference = "Stop"

if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Error "ExtensionId must be 32 lowercase letters a-p (Chrome format). Got: $ExtensionId"
}

Write-Host "[ok] Using ExtensionId: $ExtensionId"

$HostName = "com.ylct.translator"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HostJs = Join-Path $ScriptDir "dist\host.js"
$HostBat = Join-Path $ScriptDir "host.bat"
$ManifestPath = Join-Path $ScriptDir "manifest.json"

if (-not (Test-Path $HostJs))      { Write-Error "dist\host.js not found at $HostJs. Run 'npm install && npm run build' first." }
if (-not (Test-Path $ManifestPath)) { Write-Error "manifest.json not found at $ManifestPath" }

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "node.exe not found in PATH. Install Node.js 18+ first."
}
Write-Host "[ok] Node.js found: $($NodeCmd.Source)"

$BatContent = @"
@echo off
node "%~dp0dist\host.js" %*
"@
Set-Content -Path $HostBat -Value $BatContent -Encoding ASCII
Write-Host "[ok] Wrote $HostBat"

$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
$Manifest.path = $HostBat
$Manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$Manifest | ConvertTo-Json -Depth 10 | Set-Content -Path $ManifestPath -Encoding UTF8
Write-Host "[ok] Updated $ManifestPath"
Write-Host "      path             = $HostBat"
Write-Host "      allowed_origins  = chrome-extension://$ExtensionId/"

$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
if (-not (Test-Path $RegKey)) {
    New-Item -Path $RegKey -Force | Out-Null
}
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $ManifestPath
Write-Host "[ok] Registered $RegKey -> $ManifestPath"

Write-Host ""
Write-Host "Install complete. Reload the extension in chrome://extensions and click the popup."
