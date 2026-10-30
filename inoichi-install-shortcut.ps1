# INO-1 Prototype 1 Desktop Shortcut Installer
# Usage: powershell -ExecutionPolicy Bypass -File inoichi-install-shortcut.ps1 [-IconPath "C:\path\to\inoichi-app.ico"]
#
# With no -IconPath, the external app icon assets\inoichi-app.ico is used.
# The in-page logo is a separate file and is not used for shortcuts.
# An existing shortcut is updated only when its target is PowerShell and its
# arguments point at this repository's INO-1 launch or stop script.

param(
  [string]$IconPath = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ---- Configuration ----
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$LaunchScript = Join-Path $RepoRoot 'inoichi-launch.ps1'
$StopScript = Join-Path $RepoRoot 'inoichi-stop.ps1'

# ---- Locate desktop directory ----
$DesktopDir = $env:INO_DESKTOP_DIR
if (-not $DesktopDir) {
  $DesktopDir = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrEmpty($DesktopDir) -or (-not (Test-Path $DesktopDir))) {
    $DesktopDir = Join-Path $env:USERPROFILE 'Desktop'
  }
  if (-not (Test-Path $DesktopDir)) {
    $oneDriveDesktop = Join-Path $env:USERPROFILE 'OneDrive\Desktop'
    if (Test-Path $oneDriveDesktop) {
      $DesktopDir = $oneDriveDesktop
    }
  }
}

if (-not (Test-Path $DesktopDir)) {
  New-Item -ItemType Directory -Path $DesktopDir -Force | Out-Null
}

# ---- User confirmation ----
if (-not $Force -and ($env:INO_ASSUME_YES -ne '1')) {
  $answer = Read-Host "Create INO-1 start and stop shortcuts on the desktop? (y/N)"
  if ($answer -notmatch '^[Yy]') {
    Write-Host 'Canceled.'
    exit 0
  }
}

# ---- Icon handling ----
$DefaultIcon = Join-Path $RepoRoot 'assets\inoichi-app.ico'
if (-not $IconPath) {
  if (Test-Path -LiteralPath $DefaultIcon) {
    $IconPath = $DefaultIcon
  } else {
    Write-Warning "Official icon not found: $DefaultIcon (using default icon)"
  }
}

$resolvedIcon = ''
if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
  $resolvedIcon = (Resolve-Path -LiteralPath $IconPath).Path
} elseif ($IconPath) {
  Write-Warning "Icon file not found: $IconPath (using default icon)"
}

function Resolve-InoichiFinalPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($full)
  $rest = $full.Substring($root.Length)
  $current = $root.TrimEnd('\')
  foreach ($part in ($rest -split '\\')) {
    if (-not $part) { continue }
    $current = Join-Path $current $part
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if (-not $item) { return '' }
    $isLink = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isLink -and $item.Target -and @($item.Target).Count -gt 0) {
      $target = [string]@($item.Target)[0]
      if (-not [System.IO.Path]::IsPathRooted($target)) {
        $target = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $current) $target))
      }
      $current = [System.IO.Path]::GetFullPath($target)
    }
  }
  return $current
}

function Get-ShortcutArgumentFile([string]$ArgumentText) {
  if ($ArgumentText -match '-File\s+"([^"]+)"') { return $Matches[1] }
  if ($ArgumentText -match "-File\s+'([^']+)'") { return $Matches[1] }
  if ($ArgumentText -match '-File\s+(\S+)') { return $Matches[1] }
  return ''
}

# ---- Helper to avoid overwriting existing files ----
function Get-UniqueShortcutPath($Path) {
  if (-not (Test-Path $Path)) { return $Path }
  $dir = Split-Path -Parent $Path
  $base = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $ext = [System.IO.Path]::GetExtension($Path)
  $i = 1
  while ($true) {
    $candidate = Join-Path $dir "$base($i)$ext"
    if (-not (Test-Path $candidate)) { return $candidate }
    $i++
  }
}

# ---- Create shortcuts ----
$shell = New-Object -ComObject WScript.Shell

function Test-InoichiItem([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return $null -ne (Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
}

function Test-InoichiOwnShortcut($ShortcutPath, $ArgumentFile) {
  if (-not (Test-InoichiItem $ShortcutPath)) { return $false }
  try {
    $existing = $shell.CreateShortcut($ShortcutPath)
  } catch {
    return $false
  }
  $target = [string]$existing.TargetPath
  $argumentText = [string]$existing.Arguments
  if ($target -notmatch '(?i)\\powershell(\.exe)?$') { return $false }
  $actualFile = Get-ShortcutArgumentFile $argumentText
  if (-not $actualFile) { return $false }
  $expectedFinal = Resolve-InoichiFinalPath $ArgumentFile
  $actualFinal = Resolve-InoichiFinalPath $actualFile
  if (-not $expectedFinal -or -not $actualFinal) { return $false }
  return [string]::Equals($expectedFinal, $actualFinal, [StringComparison]::OrdinalIgnoreCase)
}

function New-InoichiShortcut($DisplayName, $PsPath, $ArgumentFile) {
  $desired = Join-Path $DesktopDir "$DisplayName.lnk"
  if (Test-InoichiOwnShortcut $desired $ArgumentFile) {
    $shortcut = $shell.CreateShortcut($desired)
    if ($resolvedIcon) {
      $shortcut.IconLocation = "$resolvedIcon,0"
    }
    $shortcut.Save()
    Write-Host "Updated: $desired"
    return
  }

  $shortcutPath = Get-UniqueShortcutPath $desired
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $PsPath
  $shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ArgumentFile`""
  $shortcut.WorkingDirectory = $RepoRoot
  if ($resolvedIcon) {
    $shortcut.IconLocation = "$resolvedIcon,0"
  } else {
    # Default Windows PowerShell icon.
    $shortcut.IconLocation = "$PsPath,0"
  }
  $shortcut.Save()
  Write-Host "Created: $shortcutPath"
}

New-InoichiShortcut 'INO-1 起動' 'powershell.exe' $LaunchScript
New-InoichiShortcut 'INO-1 終了' 'powershell.exe' $StopScript

# Existing taskbar pins stay pinned. Only the icon path is rewritten.
# User Pinned is hidden, so the lookup uses -Force.
$updatedPaths = @(
  (Join-Path $DesktopDir 'INO-1 起動.lnk'),
  (Join-Path $DesktopDir 'INO-1 終了.lnk')
)
$pinDir = Join-Path $env:APPDATA 'Microsoft\Windows\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$pinItems = @(Get-ChildItem -Path $pinDir -Filter '*.lnk' -File -Force -ErrorAction SilentlyContinue)
$pinItems | ForEach-Object {
  $pinPath = $_.FullName
  foreach ($script in @($LaunchScript, $StopScript)) {
    if (Test-InoichiOwnShortcut $pinPath $script) {
      $pinned = $shell.CreateShortcut($pinPath)
      if ($resolvedIcon) { $pinned.IconLocation = "$resolvedIcon,0" }
      $pinned.Save()
      Write-Host "Pinned icon updated: $pinPath"
      $updatedPaths += $pinPath
      break
    }
  }
}

if (-not ('InoichiIconNotify' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InoichiIconNotify {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern void SHChangeNotify(int eventId, uint flags, string item1, IntPtr item2);
}
'@
}
foreach ($updated in $updatedPaths) {
  if (Test-InoichiItem $updated) {
    [InoichiIconNotify]::SHChangeNotify(0x2000, 0x0005, $updated, [IntPtr]::Zero)
  }
}
if ($resolvedIcon) {
  [InoichiIconNotify]::SHChangeNotify(0x2000, 0x0005, $resolvedIcon, [IntPtr]::Zero)
}
[InoichiIconNotify]::SHChangeNotify(0x08000000, 0x1000, $null, [IntPtr]::Zero)

Write-Host 'INO-1 desktop shortcuts created.'
exit 0
