# INO-1 Stop Script
# Usage: powershell -ExecutionPolicy Bypass -File inoichi-stop.ps1
# Safely stops only the INO-1 server identified by its PID file.

$ErrorActionPreference = 'Stop'

# ---- Configuration ----
$AppDataDir = if ($env:INO_PID_DIR) { $env:INO_PID_DIR } else { Join-Path $env:LOCALAPPDATA 'INO-1' }
$PidFile = Join-Path $AppDataDir 'server.pid'

function Write-Log($Message) {
  try {
    if (-not (Test-Path $AppDataDir)) {
      New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null
    }
    $logFile = Join-Path $AppDataDir 'launcher.log'
    $line = '{0:yyyy-MM-dd HH:mm:ss} [stop] {1}' -f (Get-Date), $Message
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {}
}

# ---- 1. Read PID file ----
if (-not (Test-Path $PidFile)) {
  Write-Host 'No start record found. The INO-1 server may not be running.'
  exit 0
}

$lines = Get-Content $PidFile -Encoding UTF8
$pidValue = $null
$startedValue = $null
foreach ($line in $lines) {
  if ($line -match '^PID=(\d+)') { $pidValue = [int]$matches[1] }
  elseif ($line -match '^Started=(.+)') { $startedValue = $matches[1] }
}

if (-not $pidValue) {
  Write-Warning 'PID file is malformed.'
  exit 1
}

# ---- 2. Resolve process ----
$proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Host 'The recorded process has already exited.'
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

# ---- 3. Verify command line contains inoichi-server.js ----
$wmiProc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
$commandLine = ''
if ($wmiProc) { $commandLine = $wmiProc.CommandLine }

if (-not ($commandLine -like '*inoichi-server.js*')) {
  $msg = "Process $pidValue is not the INO-1 server; will not stop it."
  Write-Warning $msg
  Write-Log $msg
  exit 1
}

# ---- 4. Verify start time to prevent stopping a reused PID ----
if ($startedValue) {
  try {
    $storedStart = [DateTime]::Parse($startedValue, [System.Globalization.CultureInfo]::InvariantCulture, 'RoundtripKind').ToUniversalTime()
    $actualStart = $proc.StartTime.ToUniversalTime()
    if ($storedStart -ne $actualStart) {
      $msg = "Process $pidValue start time does not match; possible PID reuse. Will not stop it."
      Write-Warning $msg
      Write-Log $msg
      exit 1
    }
  } catch {
    Write-Warning "Could not verify process start time: $_"
    # Do not stop if we cannot verify the start time.
    exit 1
  }
}

# ---- 5. Stop the server ----
Write-Log "Stopping INO-1 server PID=$pidValue"
Stop-Process -Id $pidValue -Force
Write-Host 'INO-1 server stopped.'

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
exit 0
