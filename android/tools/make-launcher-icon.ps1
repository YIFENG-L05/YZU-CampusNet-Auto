# 从用户提供的方形 logo 图生成 Android 启动图标（自适应 + 传统 + 圆形）
#
# 用法（PowerShell 5.1 或 7 均可）：
#   & android\tools\make-launcher-icon.ps1 -Source "C:\Users\...\图标.jpeg"
#
# 产出（app/src/main/res/）：
#   mipmap-anydpi-v26/ic_launcher.xml / ic_launcher_round.xml  ← 自适应图标
#   mipmap-{m,h,xh,xxh,xxxhdpi}/ic_launcher.png               ← 传统方形（白底 + logo 占 ~67%）
#   mipmap-{m,h,xh,xxh,xxxhdpi}/ic_launcher_round.png         ← 圆形版
#   mipmap-{m,h,xh,xxh,xxxhdpi}/ic_launcher_background.png    ← 自适应背景（整张源图，108dp）
#
# 为什么用"整张源图做自适应背景"而不是抠出 logo 当前景：
#   · 源图是**白底黑 logo**、logo 居中且只占画面 46% —— 直接整张铺满 108dp 画布，
#     被遮罩裁掉的是四周留白，logo 本身落在安全区内（可见区约 72dp 时 logo 占 ~69%）；
#   · 不用逐像素抠图，任何底色都不需要"猜"，忠实于用户给的图。
param(
    [Parameter(Mandatory = $true)][string]$Source,
    # logo 在源图里占的比例（用于传统图标的裁切倍率：1/0.695 ≈ 让 logo 占图标 67%）
    [double]$LegacyCrop = 0.695
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) { throw "找不到源图：$Source" }
$resRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\app\src\main\res')).Path

$src = New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromFile($Source))
Write-Host "源图：$($src.Width)x$($src.Height)"

# 传统图标：从源图中心裁掉四周留白（默认只留中心 69.5%），再缩放到目标尺寸
$side = [int]($src.Width * $LegacyCrop)
$cropX = [int](($src.Width - $side) / 2)
$cropY = [int](($src.Height - $side) / 2)

$densities = @(
    @{ dir = 'mipmap-mdpi'; legacy = 48; adaptive = 108 },
    @{ dir = 'mipmap-hdpi'; legacy = 72; adaptive = 162 },
    @{ dir = 'mipmap-xhdpi'; legacy = 96; adaptive = 216 },
    @{ dir = 'mipmap-xxhdpi'; legacy = 144; adaptive = 324 },
    @{ dir = 'mipmap-xxxhdpi'; legacy = 192; adaptive = 432 }
)

function Save-Png($bmp, $path) {
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host ("  -> {0} {1}x{2}" -f (Split-Path $path -Leaf), $bmp.Width, $bmp.Height)
}

function New-Graphics($bmp) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    return $g
}

foreach ($d in $densities) {
    $outDir = Join-Path $resRoot $d.dir
    Write-Host "密度 $($d.dir)"

    # ① 传统方形图标（白底 + logo）
    $legacy = New-Object System.Drawing.Bitmap $d.legacy, $d.legacy
    $g = New-Graphics $legacy
    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src,
        (New-Object System.Drawing.Rectangle 0, 0, $d.legacy, $d.legacy),
        (New-Object System.Drawing.Rectangle $cropX, $cropY, $side, $side),
        [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    Save-Png $legacy (Join-Path $outDir 'ic_launcher.png')

    # ② 圆形版
    $round = New-Object System.Drawing.Bitmap $d.legacy, $d.legacy
    $g = New-Graphics $round
    $clip = New-Object System.Drawing.Drawing2D.GraphicsPath
    $clip.AddEllipse(0, 0, $d.legacy, $d.legacy)
    $g.SetClip($clip)
    $g.DrawImage($legacy, 0, 0)
    $g.Dispose()
    Save-Png $round (Join-Path $outDir 'ic_launcher_round.png')

    # ③ 自适应背景（整张源图铺满 108dp 画布）
    $bg = New-Object System.Drawing.Bitmap $d.adaptive, $d.adaptive
    $g = New-Graphics $bg
    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src,
        (New-Object System.Drawing.Rectangle 0, 0, $d.adaptive, $d.adaptive),
        (New-Object System.Drawing.Rectangle 0, 0, $src.Width, $src.Height),
        [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    Save-Png $bg (Join-Path $outDir 'ic_launcher_background.png')

    $legacy.Dispose(); $round.Dispose(); $bg.Dispose()
}

# ④ 自适应图标描述文件（前景透明：内容全在背景层）
$anydpi = Join-Path $resRoot 'mipmap-anydpi-v26'
if (-not (Test-Path $anydpi)) { New-Item -ItemType Directory -Path $anydpi | Out-Null }
$adaptive = @'
<?xml version="1.0" encoding="utf-8"?>
<!-- 自适应图标：背景 = 用户提供的整张 logo 图（白底黑 logo，内容居中），前景留空 -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@android:color/transparent" />
</adaptive-icon>
'@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $anydpi 'ic_launcher.xml'), $adaptive, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $anydpi 'ic_launcher_round.xml'), $adaptive, $utf8NoBom)
Write-Host '  -> mipmap-anydpi-v26/ic_launcher.xml + ic_launcher_round.xml'

$src.Dispose()
Write-Host '完成。'
