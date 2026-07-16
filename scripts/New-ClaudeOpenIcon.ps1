#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Path)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$target = [System.IO.Path]::GetFullPath($Path)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
$bmp = New-Object System.Drawing.Bitmap 256,256
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,92,61,153))
  $fg = New-Object System.Drawing.Pen ([System.Drawing.Color]::White),22
  $accent = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255,203,180,255)),10
  try {
    $g.FillEllipse($bg,8,8,240,240)
    $g.DrawEllipse($fg,57,57,142,142)
    $g.DrawArc($accent,79,79,98,98,32,296)
    $g.DrawLine($fg,163,163,205,205)
  } finally { $bg.Dispose(); $fg.Dispose(); $accent.Dispose() }
  $png = New-Object System.IO.MemoryStream
  $bmp.Save($png,[System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $png.ToArray()
  $fs = [System.IO.File]::Create($target)
  $bw = New-Object System.IO.BinaryWriter $fs
  try {
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
    $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$bytes.Length); $bw.Write([UInt32]22); $bw.Write($bytes)
  } finally { $bw.Dispose(); $fs.Dispose(); $png.Dispose() }
} finally { $g.Dispose(); $bmp.Dispose() }
Write-Host "Created $target"
