# Generates the Project Hub application icon at assets\project-hub.ico.
#
# The icon mirrors the product logo (frontend/public/logo.svg): a rounded
# accent-blue tile with three ascending bars — Capture. Build. Ship. — drawn
# with GDI+ at 16/24/32/48/64/128/256 px and packed as a multi-size ICO with
# PNG-compressed frames (supported by Windows Vista and later).
#
# Run once after changing the logo geometry or colours:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-icon.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$AssetsDir = Join-Path $RepoRoot 'assets'
$OutPath   = Join-Path $AssetsDir 'project-hub.ico'

New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

# Product palette (matches frontend/public/logo.svg)
$TileColor = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)    # #2563eb
$BarColor  = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)  # #ffffff

$Sizes = @(16, 24, 32, 48, 64, 128, 256)

function New-LogoBitmap {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Geometry from the 32-unit logo grid, scaled to $Size.
    $s = $Size / 32.0
    $tileBrush = New-Object System.Drawing.SolidBrush $TileColor
    $barBrush  = New-Object System.Drawing.SolidBrush $BarColor

    # Rounded tile: x=2 y=2 w=28 h=28 rx=8
    $rx = [int](2 * $s); $ry = [int](2 * $s)
    $rw = [int](28 * $s); $rh = [int](28 * $s); $rr = [Math]::Max(1, [int](8 * $s))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $rr * 2
    $path.AddArc($rx, $ry, $d, $d, 180, 90)
    $path.AddArc($rx + $rw - $d, $ry, $d, $d, 270, 90)
    $path.AddArc($rx + $rw - $d, $ry + $rh - $d, $d, $d, 0, 90)
    $path.AddArc($rx, $ry + $rh - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($tileBrush, $path)

    # Bars: y=9/14.5/20 h=3 rx=1.5, x=8, widths 8/12/16
    foreach ($bar in @(@(8, 9.0, 8), @(8, 14.5, 12), @(8, 20.0, 16))) {
        $bx = [int]($bar[0] * $s)
        $by = [int]($bar[1] * $s)
        $bw = [int]($bar[2] * $s)
        $bh = [Math]::Max(1, [int](3 * $s))
        $br = [Math]::Max(1, [int](1.5 * $s))
        if ($bw -gt (2 * $br) -and $bh -gt (2 * $br)) {
            $bpath = New-Object System.Drawing.Drawing2D.GraphicsPath
            $bd = $br * 2
            $bpath.AddArc($bx, $by, $bd, $bd, 180, 90)
            $bpath.AddArc($bx + $bw - $bd, $by, $bd, $bd, 270, 90)
            $bpath.AddArc($bx + $bw - $bd, $by + $bh - $bd, $bd, $bd, 0, 90)
            $bpath.AddArc($bx, $by + $bh - $bd, $bd, $bd, 90, 90)
            $bpath.CloseFigure()
            $g.FillPath($barBrush, $bpath)
        } else {
            $g.FillRectangle($barBrush, $bx, $by, $bw, $bh)
        }
    }

    $tileBrush.Dispose()
    $barBrush.Dispose()
    $g.Dispose()
    return $bmp
}

# Render every size and capture each as PNG bytes.
$frames = @()
foreach ($size in $Sizes) {
    $bmp = New-LogoBitmap -Size $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames += [PSCustomObject]@{ Size = $size; Png = $ms.ToArray() }
    $ms.Dispose()
    $bmp.Dispose()
}

# Pack ICONDIR + ICONDIRENTRY[] + PNG payloads.
$entrySize = 6 + (16 * $frames.Count)
$fs = [System.IO.File]::Create($OutPath)
$bw = New-Object System.IO.BinaryWriter $fs

# ICONDIR: reserved=0, type=1 (icon), count
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$frames.Count)

$offset = $entrySize
foreach ($f in $frames) {
    $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }
    $bw.Write([byte]$dim)        # width (0 = 256)
    $bw.Write([byte]$dim)        # height
    $bw.Write([byte]0)           # color count
    $bw.Write([byte]0)           # reserved
    $bw.Write([uint16]1)         # color planes
    $bw.Write([uint16]32)        # bits per pixel
    $bw.Write([uint32]$f.Png.Length)
    $bw.Write([uint32]$offset)
    $offset += $f.Png.Length
}
foreach ($f in $frames) {
    $bw.Write($f.Png)
}

$bw.Flush()
$bw.Dispose()
$fs.Close()

Write-Host "Generated multi-size icon ($($Sizes -join '/') px): $OutPath"
