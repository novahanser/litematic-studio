Add-Type -AssemblyName System.Drawing
$target = Join-Path $PSScriptRoot '../resources'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256,256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(255,15,25,35))
function Draw-Poly($color, $coords) {
  $points = [System.Drawing.PointF[]]@($coords | ForEach-Object { [System.Drawing.PointF]::new($_[0], $_[1]) })
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($color))
  $graphics.FillPolygon($brush,$points)
  $brush.Dispose()
}
Draw-Poly '#77DEC3' @(@(128,32),@(222,86),@(128,140),@(34,86))
Draw-Poly '#339E94' @(@(34,97),@(121,147),@(121,247),@(34,195))
Draw-Poly '#4698B0' @(@(135,147),@(222,97),@(222,195),@(135,247))
$png = Join-Path $target 'icon.png'
$bitmap.Save($png,[System.Drawing.Imaging.ImageFormat]::Png)
$bytes = [System.IO.File]::ReadAllBytes($png)
$stream = [System.IO.File]::Create((Join-Path $target 'icon.ico'))
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$bytes.Length)
$writer.Write([uint32]22)
$writer.Write($bytes)
$writer.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
