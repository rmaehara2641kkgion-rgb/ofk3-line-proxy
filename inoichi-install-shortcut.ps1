# INO-1 Prototype 1 Desktop Shortcut Installer
# Usage: powershell -ExecutionPolicy Bypass -File inoichi-install-shortcut.ps1 [-IconPath "C:\path\to\inoichi.ico"]
#
# With no -IconPath, the official icon assets\inoichi.ico is used.
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
$DefaultIcon = Join-Path $RepoRoot 'assets\inoichi.ico'
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

function Test-InoichiOwnShortcut($ShortcutPath, $ArgumentFile) {
  if (-not (Test-Path -LiteralPath $ShortcutPath)) { return $false }
  try {
    $existing = $shell.CreateShortcut($ShortcutPath)
  } catch {
    return $false
  }
  $target = [string]$existing.TargetPath
  $argumentText = [string]$existing.Arguments
  if ($target -notmatch '(?i)\\powershell(\.exe)?$') { return $false }
  $expected = [System.IO.Path]::GetFullPath($ArgumentFile)
  if ($argumentText.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  return $true
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

Write-Host 'INO-1 desktop shortcuts created.'
exit 0
