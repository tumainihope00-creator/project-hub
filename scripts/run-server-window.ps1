# Internal helper (used only by project-hub-launcher.ps1).
# Opens a console window titled $Title, changes to $ServerDir, and runs `npm run dev`
# (the dev command used for both the backend and the frontend).
# Keeps the window open if the server exits so the user can read the error.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerDir,
    [string]$Title = 'Project Hub Server'
)

try {
    $Host.UI.RawUI.WindowTitle = $Title
}
catch {
    # non-interactive host - ignore
}

Write-Host "[$Title] Working in: $ServerDir"
Write-Host "[$Title] Running: npm run dev"
Write-Host ''

try {
    Set-Location -LiteralPath $ServerDir
    & npm.cmd run dev
}
catch {
    Write-Host ''
    Write-Host "[$Title] ERROR: the server exited with an error above." -ForegroundColor Red
    Write-Host '[Project Hub] To troubleshoot:' -ForegroundColor Yellow
    Write-Host '[Project Hub]   - Make sure Node.js is installed and on PATH (`node -v`).'
    Write-Host '[Project Hub]   - Run  npm install  in this folder if dependencies are missing.'
    Write-Host "[Project Hub]   - Check the backend .env (backend\.env) for the correct DATABASE_URL and port."
    Read-Host 'Press Enter to close this window.'
    exit 1
}

Write-Host ''
Write-Host "[$Title] Server stopped."
Read-Host 'Press Enter to close this window.'