param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Out)

# Get the icon Windows itself uses for a shell item (works for UWP / MSIX apps
# whose logo lives in resources.pri instead of loose files).
# $Path can be a real file path or a parsing name such as
#   shell:AppsFolder\PackageFamilyName!AppId
#
# The bitmap returned by IShellItemImageFactory is a 32bpp DIB (with alpha).
# Image.FromHbitmap drops the alpha channel -> black background in the PNG,
# so read the raw bits with GetDIBits and build a 32bpp bitmap by hand.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$code = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class ShellThumb {
  [StructLayout(LayoutKind.Sequential)]
  public struct SIZE { public int cx; public int cy; }

  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory {
    void GetImage(SIZE size, int flags, out IntPtr phbm);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAP {
    public int bmType;
    public int bmWidth;
    public int bmHeight;
    public int bmWidthBytes;
    public ushort bmPlanes;
    public ushort bmBitsPixel;
    public IntPtr bmBits;
  }

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

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItemImageFactory ppv);

  [DllImport("gdi32.dll")]
  static extern int GetObject(IntPtr hObject, int nCount, out BITMAP lpObject);

  [DllImport("gdi32.dll")]
  static extern IntPtr CreateCompatibleDC(IntPtr hdc);

  [DllImport("gdi32.dll")]
  static extern bool DeleteDC(IntPtr hdc);

  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr hObject);

  [DllImport("gdi32.dll")]
  static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bi, uint usage);

  public static bool Save(string path, string outFile, int size) {
    Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory factory;
    SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out factory);
    IntPtr hbm = IntPtr.Zero;
    SIZE s;
    s.cx = size;
    s.cy = size;
    // SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK
    factory.GetImage(s, 5, out hbm);
    if (hbm == IntPtr.Zero) return false;
    try {
      BITMAP bm;
      if (GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), out bm) == 0) return false;
      int w = bm.bmWidth, h = bm.bmHeight;
      if (w <= 0 || h <= 0) return false;

      BITMAPINFOHEADER bi = new BITMAPINFOHEADER();
      bi.biSize = 40;
      bi.biWidth = w;
      bi.biHeight = -h;      // negative height -> top-down rows
      bi.biPlanes = 1;
      bi.biBitCount = 32;
      bi.biCompression = 0;  // BI_RGB
      bi.biSizeImage = (uint)(w * h * 4);

      byte[] buf = new byte[w * h * 4];
      IntPtr hdc = CreateCompatibleDC(IntPtr.Zero);
      int lines = 0;
      try {
        lines = GetDIBits(hdc, hbm, 0, (uint)h, buf, ref bi, 0);
      } finally {
        DeleteDC(hdc);
      }
      if (lines == 0) return false;

      // No alpha at all -> the shell handed us an opaque bitmap: make it fully opaque.
      bool anyAlpha = false;
      for (int i = 3; i < buf.Length; i += 4) {
        if (buf[i] != 0) { anyAlpha = true; break; }
      }
      if (!anyAlpha) {
        for (int i = 3; i < buf.Length; i += 4) buf[i] = 255;
      }

      // Detect premultiplied alpha: premultiplied data always satisfies channel <= alpha.
      bool premul = true;
      if (anyAlpha) {
        for (int i = 0; i < buf.Length; i += 4) {
          int a = buf[i + 3];
          if (buf[i] > a || buf[i + 1] > a || buf[i + 2] > a) { premul = false; break; }
        }
      }
      PixelFormat fmt = premul ? PixelFormat.Format32bppPArgb : PixelFormat.Format32bppArgb;

      using (Bitmap bmp = new Bitmap(w, h, fmt)) {
        BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, fmt);
        try {
          for (int y = 0; y < h; y++) {
            Marshal.Copy(buf, y * w * 4, new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), w * 4);
          }
        } finally {
          bmp.UnlockBits(bd);
        }
        bmp.Save(outFile, ImageFormat.Png);
      }
      return true;
    } finally {
      DeleteObject(hbm);
    }
  }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing.dll

if (-not [ShellThumb]::Save($Path, $Out, 256)) { exit 2 }
