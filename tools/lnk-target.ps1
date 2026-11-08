param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Out)

# Resolve a .lnk through the Windows Shell.
# Some shortcuts store their target as an IDList (or point at a Start Menu app
# entry), so the plain link info has no path at all. The Shell still knows the
# answer: System.Link.TargetParsingPath is either a real path or an app id
# such as "VisualStudio.54cd7441", "PackageFamily!AppId".
# Output: "parsingPath<TAB>targetPath" written as UTF-8.

$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $Path
$leaf = Split-Path -Leaf $Path
$parsing = ''
$target = ''

try {
  $sh = New-Object -ComObject Shell.Application
  $folder = $sh.NameSpace($dir)
  if ($folder -ne $null) {
    $item = $folder.ParseName($leaf)
    if ($item -ne $null) {
      try { $parsing = [string]$item.ExtendedProperty('System.Link.TargetParsingPath') } catch { $parsing = '' }
      try { $target = [string]$item.GetLink().Target.Path } catch { $target = '' }
    }
  }
} catch {
  $parsing = ''
  $target = ''
}

$text = $parsing + "`t" + $target
[IO.File]::WriteAllText($Out, $text, (New-Object Text.UTF8Encoding($false)))
