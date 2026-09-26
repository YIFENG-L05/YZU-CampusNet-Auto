# 从用户提供的 logo 图生成 Windows 侧品牌图标（assets/icon.png + assets/icon.ico）
#
# 用法（PowerShell 5.1 / 7 均可）：
#   & tools\make-desktop-icon.ps1 -Source "C:\Users\...\图标.jpeg"
#
# 说明：
#   · assets/icon.ico 里放 16/32/48/64/128/256 六档 PNG（Vista+ 支持 PNG 压缩条目）
#   · 源图是"白底 + 居中 logo"，这里按 69.5% 中心裁切，让 logo 占图标约 67%（和 Android 侧一致）
#   · ⚠ tools/make-icon.js 是**旧的代码绘制版**（圆角方块 + 信号柱）；改品牌图标请用本脚本
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [double]$Crop = 0.695
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) { throw "找不到源图：$Source" }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $root 'assets'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$src = New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromFile($Source))
$side = [int]($src.Width * $Crop)
$cropX = [int](($src.Width - $side) / 2)
$cropY = [int](($src.Height - $side) / 2)
Write-Host "源图 $($src.Width)x$($src.Height) → 裁切 ${side}x${side}"

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src,
        (New-Object System.Drawing.Rectangle 0, 0, $size, $size),
        (New-Object System.Drawing.Rectangle $cropX, $cropY, $side, $side),
        [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    return $bmp
}

# ── 1. icon.png（512，给 Linux/macOS 与文档用）──
$png512 = New-IconBitmap 512
$png512.Save((Join-Path $outDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "  -> icon.png 512x512"
$png512.Dispose()

# ── 2. icon.ico（多尺寸，PNG 压缩条目）──
$sizes = @(16, 32, 48, 64, 128, 256)
$pngs = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,$ms.ToArray()
    $bmp.Dispose(); $ms.Dispose()
}

$icoPath = Join-Path $outDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)              # reserved
$bw.Write([UInt16]1)              # type = icon
$bw.Write([UInt16]$sizes.Count)   # image count
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    # ⚠ PowerShell 5.1 不支持行内 if 表达式，先算好再写（ICO 里 256 记 0）
    $dim = 0
    if ($s -lt 256) { $dim = $s }
    $bw.Write([Byte]$dim)         # width
    $bw.Write([Byte]$dim)         # height
    $bw.Write([Byte]0)            # 调色板
    $bw.Write([Byte]0)            # reserved
    $bw.Write([UInt16]1)          # color planes
    $bw.Write([UInt16]32)         # bits per pixel
    $bw.Write([UInt32]$pngs[$i].Length)
    $bw.Write([UInt32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush(); $bw.Close(); $fs.Close()
Write-Host ("  -> icon.ico ({0} 档：{1})" -f $sizes.Count, ($sizes -join '/'))
$src.Dispose()
Write-Host '完成。'
