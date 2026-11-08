# Extract the high resolution icon of an exe/ico/dll via SHDefExtractIcon and save it as PNG.
# Usage: powershell -NoProfile -STA -File icon-extract.ps1 -Path <exe/ico/dll> -Out <out.png>
#
# IMPORTANT: keep this file ASCII-only. PowerShell 5 without BOM decodes the file as ANSI,
# so non-ASCII comments can break the script (a stray BOM once made the whole file invalid).
param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class IconExtract {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHDefExtractIconW(string pszIconFile, int iIndex, uint uFlags, out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIconSize);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr hIcon);
  [DllImport("user32.dll")]
  static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, uint istepIfAniCur, IntPtr hbrFlickerFreeDraw, uint diFlags);
  [DllImport("gdi32.dll")]
  static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")]
  static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")]
  static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr h);
  [DllImport("gdi32.dll")]
  static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint usage, out IntPtr ppvBits, IntPtr hSection, uint offset);

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFOHEADER {
    public uint biSize;
    public int biWidth;
    public int biHeight;
    public ushort biPlanes;
    public ushort biBitCount;
    public uint biCompression;
    public uint biSizeImage;
    public int biXPelsPerMeter;
    public int biYPelsPerMeter;
    public uint biClrUsed;
    public uint biClrImportant;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFO {
    public BITMAPINFOHEADER bmiHeader;
    public uint bmiColors;
  }

  static IntPtr CreateDib(IntPtr hdc, int size, out IntPtr bits) {
    BITMAPINFO bi = new BITMAPINFO();
    bi.bmiHeader.biSize = 40;
    bi.bmiHeader.biWidth = size;
    bi.bmiHeader.biHeight = -size;   // negative -> top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = 0;  // BI_RGB
    bi.bmiHeader.biSizeImage = (uint)(size * size * 4);
    return CreateDIBSection(hdc, ref bi, 0, out bits, IntPtr.Zero, 0);
  }

  // Fill a DIB with a solid color then draw the icon over it (DI_NORMAL = 3).
  static byte[] RenderOnColor(IntPtr hdc, IntPtr hIcon, int size, byte br, byte bg, byte bb) {
    IntPtr bits;
    IntPtr dib = CreateDib(hdc, size, out bits);
    if (dib == IntPtr.Zero) return null;
    try {
      byte[] fill = new byte[size * size * 4];
      for (int i = 0; i < fill.Length; i += 4) {
        fill[i] = bb; fill[i + 1] = bg; fill[i + 2] = br; fill[i + 3] = 255;
      }
      Marshal.Copy(fill, 0, bits, fill.Length);
      IntPtr old = SelectObject(hdc, dib);
      bool ok = DrawIconEx(hdc, 0, 0, hIcon, size, size, 0, IntPtr.Zero, 3);
      SelectObject(hdc, old);
      if (!ok) return null;
      byte[] buf = new byte[size * size * 4];
      Marshal.Copy(bits, buf, 0, buf.Length);
      return buf;
    } finally {
      DeleteObject(dib);
    }
  }

  // Old icons keep transparency in a 1-bit AND mask (no alpha channel), newer ones
  // are 32bpp with real alpha. Drawing onto black and white backgrounds and
  // comparing the two recovers both cases:
  //   opaque pixel      -> identical on both      -> alpha 255
  //   transparent pixel -> black vs white         -> alpha 0
  //   semi-transparent  -> blended differently    -> alpha = 255 - (white - black)
  public static bool Save(string iconPath, string outFile, int size) {
    IntPtr large = IntPtr.Zero;
    IntPtr small = IntPtr.Zero;
    int hr = SHDefExtractIconW(iconPath, 0, 0, out large, out small, (uint)(size | (size << 16)));
    if (large == IntPtr.Zero) return false;

    IntPtr hdc = IntPtr.Zero;
    try {
      hdc = CreateCompatibleDC(IntPtr.Zero);
      byte[] onBlack = RenderOnColor(hdc, large, size, 0, 0, 0);
      byte[] onWhite = RenderOnColor(hdc, large, size, 255, 255, 255);
      if (onBlack == null || onWhite == null) return false;

      byte[] outBuf = new byte[size * size * 4];
      for (int i = 0; i < outBuf.Length; i += 4) {
        int d = onWhite[i] - onBlack[i]; // blue channel diff
        if (d <= 0) {
          outBuf[i] = onBlack[i];
          outBuf[i + 1] = onBlack[i + 1];
          outBuf[i + 2] = onBlack[i + 2];
          outBuf[i + 3] = 255;
        } else if (d >= 255) {
          outBuf[i] = 0; outBuf[i + 1] = 0; outBuf[i + 2] = 0; outBuf[i + 3] = 0;
        } else {
          int a = 255 - d;
          outBuf[i]     = (byte)Math.Min(255, onBlack[i] * 255 / a);
          outBuf[i + 1] = (byte)Math.Min(255, onBlack[i + 1] * 255 / a);
          outBuf[i + 2] = (byte)Math.Min(255, onBlack[i + 2] * 255 / a);
          outBuf[i + 3] = (byte)a;
        }
      }

      using (Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb)) {
        BitmapData bd = bmp.LockBits(new Rectangle(0, 0, size, size), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try {
          for (int y = 0; y < size; y++) {
            Marshal.Copy(outBuf, y * size * 4, new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), size * 4);
          }
        } finally {
          bmp.UnlockBits(bd);
        }
        bmp.Save(outFile, ImageFormat.Png);
      }
      return true;
    } finally {
      if (hdc != IntPtr.Zero) DeleteDC(hdc);
      DestroyIcon(large);
      if (small != IntPtr.Zero) DestroyIcon(small);
    }
  }
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing.dll

if (-not [IconExtract]::Save($Path, $Out, 256)) { exit 2 }
