# Generates a placeholder Project Hub icon at assets\project-hub.ico
# (a simple dark hub/reticle motif in the app's colors). Run once:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-icon.ps1
#
# The generated .ico is a minimal single-size placeholder acceptable for a desktop
# shortcut. For a finished icon, replace it with a real multi-size .ico (see
# assets\icon-notes.txt for the required sizes).

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$AssetsDir = Join-Path $RepoRoot 'assets'
$OutPath   = Join-Path $AssetsDir 'project-hub.ico'

New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

# App palette
$Bg    = [System.Drawing.Color]::FromArgb(13, 17, 23)     # --bg: #0d1117
$Panel = [System.Drawing.Color]::FromArgb(22, 27, 34)     # --bg-elev: #161b22
$Accent= [System.Drawing.Color]::FromArgb(88, 166, 255)   # --accent: #58a6ff

$Size = 256
$bmp  = New-Object System.Drawing.Bitmap $Size, $Size
$g    = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear($Bg)

# rounded panel
$x = 16; $y = 16; $w = 224; $h = 224; $r = 24
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $r * 2
$path.AddArc($x, $y, $d, $d, 180, 90)
$path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
$path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
$path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
$path.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush $Panel), $path)

# hub reticle: outer ring + center
$pen = New-Object System.Drawing.Pen $Accent, 22
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
$center = New-Object System.Drawing.PointF 128, 128
$g.DrawEllipse($pen, 52, 52, 152, 152)
$g.DrawLine($pen, 128, 52, 128, 204)
$g.DrawLine($pen, 52, 128, 204, 128)
$g.FillEllipse((New-Object System.Drawing.SolidBrush $Accent), 96, 96, 64, 64)
$g.FillEllipse((New-Object System.Drawing.SolidBrush $Bg), 118, 118, 20, 20)

$g.Dispose()

# Save as an ICO via GDI+ icon handle
$hicon = $bmp.GetHicon()
$icon  = [System.Drawing.Icon]::FromHandle($hicon)
$fs    = [System.IO.File]::Create($OutPath)
$icon.Save($fs)
$fs.Close()
$icon.Dispose()
$bmp.Dispose()

Write-Host "Generated placeholder icon: $OutPath"