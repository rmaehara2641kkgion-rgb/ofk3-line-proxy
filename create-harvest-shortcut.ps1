# Creates a HARVEST shortcut (Desktop or Start Menu) that uses the HARVEST emblem icon and runs start-harvest.cmd.
# Run by the user on purpose. It does NOT pin anything to the taskbar and changes no Windows settings.
# ASCII only on purpose (Windows PowerShell reads BOM-less scripts as ANSI).
param(
  [ValidateSet('Desktop', 'StartMenu')]
  [string]$Location = 'Desktop',
  [string]$Name = 'HARVEST'
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $repo 'start-harvest.cmd'
$icon = Join-Path $repo 'assets\harvest.ico'
foreach ($p in @($launcher, $icon)) {
  if (-not (Test-Path -LiteralPath $p)) { throw ('Required file not found: ' + $p) }
}

if ($Location -eq 'Desktop') { $dir = [Environment]::GetFolderPath('Desktop') }
else { $dir = [Environment]::GetFolderPath('Programs') }
if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { throw ('Target folder not found: ' + $dir) }

$path = Join-Path $dir ($Name + '.lnk')
# The target is cmd.exe (an .exe), because Windows only offers "Pin to taskbar" reliably for shortcuts to executables.
$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($path)
$s.TargetPath = $cmdExe
$s.Arguments = '/c ""' + $launcher + '""'
$s.WorkingDirectory = $repo
$s.IconLocation = $icon + ',0'
$s.Description = 'HARVEST Data Collector (local)'
$s.WindowStyle = 1
$s.Save()

Write-Host ('Shortcut created: ' + $path)
Write-Host ('  Icon   : ' + $icon)
Write-Host ('  Starts : ' + $launcher)
Write-Host ''
Write-Host 'Next step (you do this): right-click the shortcut and choose "Pin to taskbar"'
Write-Host '(on Windows 11: "Show more options" first), or drag the shortcut onto the taskbar.'
