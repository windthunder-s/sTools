$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $projectRoot 'build'

# 从原 sTools 图标的几何和文字重新渲染，提供安装器要求的 256 像素图标。
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$fill = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#087E69'))
$font = New-Object System.Drawing.Font 'Segoe UI',152,([System.Drawing.FontStyle]::Bold),([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$pngStream = New-Object System.IO.MemoryStream
try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.FillEllipse($fill,8,8,240,240)
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString('S',$font,[System.Drawing.Brushes]::White,(New-Object System.Drawing.RectangleF 0,-12,256,256),$format)
    $bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $pngStream.ToArray()
    [IO.File]::WriteAllBytes((Join-Path $buildDir 'icon.png'), $pngBytes)

    # ICO 支持 PNG 图像；宽高字节为 0 表示 256，避免 GDI 小尺寸图标限制。
    $writer = New-Object System.IO.BinaryWriter ([IO.File]::Create((Join-Path $buildDir 'icon.ico')))
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]1)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$pngBytes.Length)
        $writer.Write([UInt32]22)
        $writer.Write($pngBytes)
    } finally { $writer.Dispose() }

    foreach ($relativePath in @('resources/icons/icon.png', 'resources/icons/icon-ztools.png', 'resources/icons/windows-icon.png', 'src/renderer/src/assets/logo.png', 'src/renderer/src/assets/image/default.png', 'internal-plugins/setting/src/assets/image/default.png', 'internal-plugins/setting/public/logo.png')) {
        [IO.File]::WriteAllBytes((Join-Path $projectRoot $relativePath), $pngBytes)
    }
} finally {
    $pngStream.Dispose()
    $format.Dispose()
    $font.Dispose()
    $fill.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

