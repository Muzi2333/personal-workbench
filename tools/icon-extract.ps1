# 用 Windows SHDefExtractIcon 提取 256px 高清图标（与桌面同源），输出 PNG
# 用法: powershell -NoProfile -STA -File icon-extract.ps1 -Path <exe/ico/dll> -Out <out.png>
param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class IconExtract {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHDefExtractIconW(string pszIconFile, int iIndex, uint uFlags, out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIconSize);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing

$large = [IntPtr]::Zero
$small = [IntPtr]::Zero
# nIconSize: 低字节=大图标尺寸, 高字节=小图标尺寸
# 注意：本文件必须保存为 UTF-8 with BOM，否则 PS5 按 ANSI 解码中文注释会吃掉后续代码
$hr = [IconExtract]::SHDefExtractIconW($Path, 0, 0, [ref]$large, [ref]$small, (256 -bor (256 -shl 16)))
if ($large -eq [IntPtr]::Zero) { exit 2 }

try {
  $ico = [System.Drawing.Icon]::FromHandle($large)
  $bmp = $ico.ToBitmap()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
} finally {
  [IconExtract]::DestroyIcon($large) | Out-Null
  if ($small -ne [IntPtr]::Zero) { [IconExtract]::DestroyIcon($small) | Out-Null }
}
