# INO-1 taskbar icon shortcut installer
# Usage:
#   powershell -ExecutionPolicy Bypass -File inoichi-taskbar-shortcut.ps1
#
# This does not start a server, pin the taskbar, send notifications, or change
# HARVEST / OFK3. It only creates or updates INO-1 desktop shortcuts when a
# local launcher script is available.
#
# When this checkout has inoichi-launch.ps1 it is used automatically.
# Otherwise the script exits without creating a shortcut.
# Pass -LaunchScript to point at a launcher in another checkout.

param(
  [string]$IconPath = '',
  [string]$LaunchScript = '',
  [string]$StopScript = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DefaultIcon = Join-Path $RepoRoot 'assets\inoichi-taskbar.ico'

if (-not $LaunchScript) {
  $candidate = Join-Path $RepoRoot 'inoichi-launch.ps1'
  if (Test-Path -LiteralPath $candidate) { $LaunchScript = $candidate }
}
if (-not $StopScript) {
  $candidateStop = Join-Path $RepoRoot 'inoichi-stop.ps1'
  if (Test-Path -LiteralPath $candidateStop) { $StopScript = $candidateStop }
}

if (-not $IconPath) {
  if (Test-Path -LiteralPath $DefaultIcon) {
    $IconPath = $DefaultIcon
  } else {
    Write-Warning "Taskbar icon not found: $DefaultIcon"
    exit 1
  }
}

$resolvedIcon = ''
if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
  $resolvedIcon = (Resolve-Path -LiteralPath $IconPath).Path
} else {
  Write-Warning "Icon file not found: $IconPath"
  exit 1
}

if (-not $LaunchScript -and -not $StopScript) {
  Write-Host 'INO-1 has no local launcher in this checkout.'
  Write-Host 'No shortcut was created. OFK3 and HARVEST were not started or changed.'
  Write-Host "Taskbar icon is ready at: $resolvedIcon"
  exit 0
}

if ($LaunchScript -and -not (Test-Path -LiteralPath $LaunchScript)) {
  Write-Warning "Launch script not found: $LaunchScript"
  exit 1
}
if ($StopScript -and -not (Test-Path -LiteralPath $StopScript)) {
  Write-Warning "Stop script not found: $StopScript"
  exit 1
}

$DesktopDir = $env:INO_DESKTOP_DIR
if (-not $DesktopDir) {
  $DesktopDir = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrEmpty($DesktopDir) -or (-not (Test-Path $DesktopDir))) {
    $DesktopDir = Join-Path $env:USERPROFILE 'Desktop'
  }
  if (-not (Test-Path $DesktopDir)) {
    $oneDriveDesktop = Join-Path $env:USERPROFILE 'OneDrive\Desktop'
    if (Test-Path $oneDriveDesktop) { $DesktopDir = $oneDriveDesktop }
  }
}
if (-not (Test-Path $DesktopDir)) {
  New-Item -ItemType Directory -Path $DesktopDir -Force | Out-Null
}

if (-not $Force -and ($env:INO_ASSUME_YES -ne '1')) {
  $answer = Read-Host 'Create or update INO-1 shortcuts to use the taskbar icon? (y/N)'
  if ($answer -notmatch '^[Yy]') {
    Write-Host 'Canceled.'
    exit 0
  }
}

function Get-UniqueShortcutPath($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $Path }
  $dir = Split-Path -Parent $Path
  $base = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $ext = [System.IO.Path]::GetExtension($Path)
  $i = 1
  while ($true) {
    $candidate = Join-Path $dir "$base($i)$ext"
    if (-not (Test-Path -LiteralPath $candidate)) { return $candidate }
    $i++
  }
}

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

function New-InoichiShortcut($DisplayName, $ArgumentFile) {
  $desired = Join-Path $DesktopDir "$DisplayName.lnk"
  if (Test-InoichiOwnShortcut $desired $ArgumentFile) {
    $shortcut = $shell.CreateShortcut($desired)
    $shortcut.IconLocation = "$resolvedIcon,0"
    $shortcut.Save()
    Write-Host "Updated: $desired"
    return
  }

  $shortcutPath = Get-UniqueShortcutPath $desired
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = 'powershell.exe'
  $shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ArgumentFile`""
  $shortcut.WorkingDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($ArgumentFile))
  $shortcut.IconLocation = "$resolvedIcon,0"
  $shortcut.Save()
  Write-Host "Created: $shortcutPath"
}

# Windows PowerShell 5.1 reads this file as the ANSI code page unless it has a
# BOM. Keep the shortcut names as code points so the path stays valid.
$StartName = 'INO-1 ' + [string]([char]0x8D77) + [string]([char]0x52D5)
$StopName = 'INO-1 ' + [string]([char]0x7D42) + [string]([char]0x4E86)

if ($LaunchScript) { New-InoichiShortcut $StartName ([System.IO.Path]::GetFullPath($LaunchScript)) }
if ($StopScript) { New-InoichiShortcut $StopName ([System.IO.Path]::GetFullPath($StopScript)) }

Write-Host 'INO-1 taskbar icon shortcuts are ready. Pin them from the desktop yourself; this script does not change the taskbar.'
exit 0
