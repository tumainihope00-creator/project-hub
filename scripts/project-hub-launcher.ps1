# Project Hub launcher
# Starts the Project Hub backend + frontend in separate console windows, waits for the
# frontend to respond, then opens the default browser on the Project Hub dashboard.
#
# Location-independent: resolves the repo root from this script's own path
# (`$PSScriptRoot\..`), so it works when launched from a desktop shortcut or any folder.
#
# Test hooks (used only by automated testing, ignored in normal use):
#   PH_NO_BROWSER=1  -> do not open the browser
#   PH_AUTO_EXIT=1   -> exit after startup check instead of waiting for Enter

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Split-Path -Parent $ScriptDir
$BackendDir  = Join-Path $RepoRoot 'backend'
$FrontendDir = Join-Path $RepoRoot 'frontend'
$StateDir    = Join-Path $env:LOCALAPPDATA 'ProjectHub'
$StateFile   = Join-Path $StateDir 'state.json'
$RunWindow   = Join-Path $ScriptDir 'run-server-window.ps1'

# Launches a named window running `npm run dev` in $TargetDir and returns the window PID.
function Start-ServerWindow([string]$Name, [string]$TargetDir) {
    return Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Normal',
        '-File', ('"' + $RunWindow + '"'),
        '-ServerDir', ('"' + $TargetDir + '"'),
        '-Title', ('"' + $Name + '"')
    ) -PassThru
}

# ---------------------------------------------------------------------------
# Ports / URLs
# ---------------------------------------------------------------------------
# Prefer the port actually configured in the backend .env, fall back to defaults.
$BackendPort = 4000
$BackendEnv = Join-Path $BackendDir '.env'
if (Test-Path $BackendEnv) {
    $line = Get-Content $BackendEnv | Where-Object { $_ -match '^\s*BACKEND_PORT\s*=' } | Select-Object -First 1
    if ($line -match '=\s*(\d+)') {
        $BackendPort = [int]$Matches[1]
    }
}
$FrontendPort   = 5173
$DashboardUrl   = "http://localhost:$FrontendPort/"
$BackendHealth  = "http://localhost:$BackendPort/api/health"

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Step([string]$Message) {
    Write-Host "[Project Hub] $Message" -ForegroundColor Cyan
}

function Test-PortOpen([int]$Port) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    return ($null -ne $c)
}

function Test-Http([string]$Url) {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    }
    catch {
        return $false
    }
}

Write-Step "Repository root: $RepoRoot"

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
foreach ($dir in @($BackendDir, $FrontendDir)) {
    if (-not (Test-Path $dir)) {
        Write-Host "FATAL: Folder not found: $dir" -ForegroundColor Red
        Write-Host "       Expected a 'backend' and a 'frontend' folder alongside this launcher." -ForegroundColor Yellow
        Read-Host 'Press Enter to close this window.'
        exit 1
    }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "FATAL: Node.js 'node' was not found on PATH." -ForegroundColor Red
    Write-Host "       Install Node.js (https://nodejs.org), reopen the shortcut, and try again." -ForegroundColor Yellow
    Read-Host 'Press Enter to close this window.'
    exit 1
}

$state = @{
    started = (Get-Date).ToString('o')
    windows = @()
}

# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
Write-Step "Starting Project Hub backend..."
if (Test-PortOpen $BackendPort) {
    Write-Host "  Port $BackendPort is already in use - assuming backend is running, skipping start." -ForegroundColor Yellow
}
else {
    if (-not (Test-Path (Join-Path $BackendDir 'node_modules'))) {
        Write-Host "  Backend dependencies are missing. It may auto-install have failed; run: npm --prefix `"$BackendDir`" install" -ForegroundColor Yellow
    }
    $be  = Start-ServerWindow 'Project Hub Backend' $BackendDir
    Start-Sleep -Seconds 2
    $state.windows += @{ name = 'backend'; pid = $be.Id }
    $state | ConvertTo-Json -Depth 4 | Set-Content -Path $StateFile -Encoding UTF8
}

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------
Write-Step "Starting Project Hub frontend..."
if (Test-PortOpen $FrontendPort) {
    Write-Host "  Port $FrontendPort is already in use - assuming frontend is running, skipping start." -ForegroundColor Yellow
}
else {
    if (-not (Test-Path (Join-Path $FrontendDir 'node_modules'))) {
        Write-Host "  Frontend dependencies are missing. Run: npm --prefix `"$FrontendDir`" install" -ForegroundColor Yellow
    }
    $fe  = Start-ServerWindow 'Project Hub Frontend' $FrontendDir
    Start-Sleep -Seconds 2
    $state.windows += @{ name = 'frontend'; pid = $fe.Id }
    $state | ConvertTo-Json -Depth 4 | Set-Content -Path $StateFile -Encoding UTF8
}

# ---------------------------------------------------------------------------
# Wait for the frontend to actually respond
# ---------------------------------------------------------------------------
Write-Step "Waiting for Project Hub (frontend on port $FrontendPort)..."
$deadline = (Get-Date).AddSeconds(45)
$ready    = $false
while ((Get-Date) -lt $deadline) {
    if (Test-Http $DashboardUrl) { $ready = $true; break }
    Start-Sleep -Seconds 1
}

if (-not $ready) {
    Write-Host "ERROR: Project Hub frontend did not respond at $DashboardUrl within 45 seconds." -ForegroundColor Red
    Write-Host "  Check the 'Project Hub Frontend' window: it should show a running Vite dev server (Local: http://localhost:$FrontendPort/)."
    Write-Host "  Check the 'Project Hub Backend' window for dependency or port errors."
    Write-Host "  If a port is blocked, close the other program using it, then run this launcher again."
    if ($env:PH_AUTO_EXIT -ne '1') { Read-Host 'Press Enter to close this launcher window.' }
    exit 1
}
Write-Host "  Frontend is responding." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Backend health (informational)
# ---------------------------------------------------------------------------
Write-Step "Checking Project Hub backend..."
if (Test-Http $BackendHealth) {
    Write-Host "  Backend is healthy (port $BackendPort)." -ForegroundColor Green
}
else {
    Write-Host "  WARNING: backend is not responding on port $BackendPort yet." -ForegroundColor Yellow
    Write-Host "  The frontend will show an error when loading the dashboard. Check the 'Project Hub Backend' window." -ForegroundColor Yellow
}

Write-Step "Project Hub is ready: $DashboardUrl"

if ($env:PH_NO_BROWSER -ne '1') {
    Write-Step "Opening default browser..."
    Start-Process $DashboardUrl
}

Write-Host ''
Write-Host '  Backend window : "Project Hub Backend"  (port ' $BackendPort ')'
Write-Host '  Frontend window: "Project Hub Frontend" (port ' $FrontendPort ')'
Write-Host ''
Write-Host '  Servers keep running after you close this launcher window.'
Write-Host '  To stop them later, double-click "Stop Project Hub.bat" in the project folder' 
Write-Host '  (or run: scripts\stop-project-hub.ps1). Only Project Hub processes are stopped.'
Write-Host ''

if ($env:PH_AUTO_EXIT -eq '1') { exit 0 }
Read-Host 'Press Enter to close this launcher window (servers keep running).'