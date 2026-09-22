# Project Hub stop script
# Safely stops ONLY the processes started by Project Hub:
#   - the console windows recorded by the launcher (and their child process trees)
#   - as a fallback, anything listening on Project Hub's ports whose command line
#     references this project's backend/frontend folders
# It never uses taskkill /IM node.exe, so unrelated Node projects are untouched.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

$StateFile = Join-Path $env:LOCALAPPDATA 'ProjectHub\state.json'
$RepoRoot  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Get-TreePids([int]$ParentPid) {
    <#
      Recursively collect all descendant process IDs of $ParentPid.
      Parent-first order; callers should kill in reverse so children die first.
    #>
    $out = @()
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentPid" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        $out += $child.ProcessId
        $out += Get-TreePids $child.ProcessId
    }
    return @($out)
}

$killed = @()

# 1) Kill trees recorded by the launcher
if (Test-Path $StateFile) {
    try {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        Write-Host '[Project Hub] Stopping launcher-managed processes...'
        foreach ($w in $state.windows) {
            $rootPid = [int]$w.pid
            $tree = @(Get-TreePids $rootPid)
            # deepest first, then the window itself
            [array]::Reverse($tree)
            foreach ($procId in $tree) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; $killed += $procId }
            Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue; $killed += $rootPid
        }
    }
    catch {
        Write-Warning "Could not read state file ($StateFile). Falling back to port scan."
    }
    Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
}

# 2) Fallback: stop only listeners on Project Hub ports that belong to this project
foreach ($port in @(4000, 5173)) {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -and $proc.CommandLine -match [regex]::Escape($RepoRoot)) {
            Write-Host ("  Stopping listener on port {0} (PID {1})" -f $port, $conn.OwningProcess)
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            $killed += $conn.OwningProcess
        }
    }
}

if ($killed.Count -eq 0) {
    Write-Host '[Project Hub] Nothing to stop - no Project Hub processes are running.'
}
else {
    Write-Host ("[Project Hub] Stopped {0} process(es)." -f ($killed | Sort-Object -Unique).Count)
    Write-Host '  Your browser window stays open; just close it manually.'
}