# Creates a "Project Hub" shortcut on the Windows Desktop that launches the one-click
# launcher, using the custom Project Hub icon when available.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
#
# (No icon needed - the shortcut uses the default .bat icon if assets\project-hub.ico is missing.)

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir

$TargetBat   = Join-Path $RepoRoot 'Start Project Hub.bat'
$IconPath    = Join-Path $RepoRoot 'assets\project-hub.ico'
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$LnkPath     = Join-Path $DesktopPath 'Project Hub.lnk'

if (-not (Test-Path $TargetBat)) {
    throw "Launcher not found: $TargetBat"
}
if (-not (Test-Path $LnkPath)) {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($LnkPath)
    $sc.TargetPath       = $TargetBat
    $sc.WorkingDirectory = $RepoRoot
    $sc.Description      = 'Project Hub - launch backend + frontend and open dashboard'
    if (Test-Path $IconPath) { $sc.IconLocation = "$IconPath,0" }
    $sc.Save()
    Write-Host "Created shortcut: $LnkPath"
}
else {
    Write-Host "Shortcut already exists: $LnkPath  (skipped)"
    Write-Host "If it was created without the icon, delete it and re-run this script, then right-click > Properties > Change icon."
}

Write-Host "Target : $TargetBat"
Write-Host "Working: $RepoRoot"
if (Test-Path $IconPath) { Write-Host "Icon   : $IconPath" } else { Write-Host "Icon   : (none - using default)" }